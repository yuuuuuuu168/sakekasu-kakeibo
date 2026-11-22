import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpUserPoolAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import type * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as ses from 'aws-cdk-lib/aws-ses';
import { OCR_JOB_PARTITION_PREFIX, OCR_JOB_STALE_MS } from '../lambda/shared/ocr-job';
import { MAIL_INBOX_PARTITION_PREFIX, MAIL_RELAY_PARTITION_PREFIX, USER_PARTITION_PREFIX } from '../lambda/shared/user-partition';
import {
  DEFAULT_ANTHROPIC_MODEL_OCR,
  IDENTITY_TOKEN_AUDIENCE,
  IDENTITY_TOKEN_SECONDS,
} from '../lambda/ocr-receipt/llm-constants';
import type { AnthropicFederation } from './anthropic-federation';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';
import { addApiAlarms } from './api-alarms';
import { appFunction } from './app-function';
import { lambdaLogGroup } from './log-group';
import { userPoolRegion, type SharedAuth } from './shared-auth';

/**
 * OCR に使う推論プロファイルと、その振り先の基盤モデル。
 *
 * InvokeModel の認可はプロファイル本体と振り先の foundation-model の**両方**を見る。
 * プロファイルの ARN だけを許可すると、振り先に当たったリクエストだけが
 * AccessDeniedException で落ちる。この 2 つと振り先リージョンは
 * sakekasu-builder が同じアカウント（ap-northeast-1）で実測したもので、
 * モデルを差し替えるときは次のコマンドで振り先を取り直すこと。
 *
 * ```sh
 * aws bedrock list-inference-profiles --region ap-northeast-1 \
 *   --query "inferenceProfileSummaries[?inferenceProfileId=='<profile-id>'].models"
 * ```
 *
 * Haiku 4.5 では感熱紙の細かい印字や半角カナを読み違え、読めない欄を作り話で
 * 埋めることがあったので、jp. の推論プロファイルにある最新の Sonnet に上げた。
 * 振り先（ap-northeast-1 / ap-northeast-3）は 2026-10 に上のコマンドで確かめてある。
 */
const BEDROCK_MODEL_ID = 'jp.anthropic.claude-sonnet-4-6';
const BEDROCK_FOUNDATION_MODEL_ID = 'anthropic.claude-sonnet-4-6';
const BEDROCK_INFERENCE_REGIONS = ['ap-northeast-1', 'ap-northeast-3'];

/**
 * OCR の既定の呼び先は Claude API（モデルは llm-constants.ts の DEFAULT_ANTHROPIC_MODEL_OCR）。
 * Claude API は API キーではなく ID 連携で入るので、IAM で絞るものはモデルではなく
 * STS の GetWebIdentityToken（宛先と寿命）になる。Bedrock はクレジット切れや障害のときの控え。
 */
const ANTHROPIC_MODEL_OCR = DEFAULT_ANTHROPIC_MODEL_OCR;

/**
 * カテゴリ判定に使う TypeSafe のモデル。Bedrock には無いモデルなので、
 * こちらは推論プロファイルではなく TypeSafe の API を直接叩く。
 * `jev-latest` は世代が上がると中身が変わる。固定したいときは世代付きの ID に差し替える。
 */
const TYPESAFE_MODEL_ID = 'jev-latest';

/** カテゴリ判定の経路に掛ける流量の上限（毎秒の回数と瞬間の回数）。理由は経路を足すところにある */
export const CLASSIFY_RATE_LIMIT = 1;
export const CLASSIFY_BURST_LIMIT = 5;

/**
 * レシートの読み取りを受け付ける経路の流量の上限。読み取りは非同期になったので、
 * OCR の同時実行の天井（3）を超えた呼び出しも弾かれずに Lambda の中で順番待ちになる。
 * ループで叩かれるとモデルの課金が積み上がるので、受付の段で絞る。
 * 画面はレシート 1 枚につき 1 回しか呼ばない。
 */
export const OCR_START_RATE_LIMIT = 1;
export const OCR_START_BURST_LIMIT = 5;

/**
 * 下書き登録（Muse から呼ぶ POST /draft-entries）の流量の上限。1 日の件数（20 件）は関数の中で数える。
 * こちらは鍵を持たない呼び手が叩き続けたときに、関数とシークレットの読み出しまで届く数を抑える
 */
export const MAIL_INBOX_RATE_LIMIT = 1;
export const MAIL_INBOX_BURST_LIMIT = 3;

/**
 * 読み取りの Lambda のタイムアウト。API Gateway の 30 秒には縛られない。
 * 長いレシートを複数枚で読む、Claude API で失敗して Bedrock で読み直す、といった場合でも
 * 収まる長さにしておく。ジョブを「落ちた」とみなす時間（OCR_JOB_STALE_MS）はこれより長く取る。
 */
export const OCR_TIMEOUT_SECONDS = 240;
if (OCR_TIMEOUT_SECONDS * 1000 >= OCR_JOB_STALE_MS) {
  throw new Error('OCR_JOB_STALE_MS は OCR の Lambda のタイムアウトより長くすること');
}

export interface ApiStackProps extends cdk.StackProps {
  envName: string;
  table: dynamodb.ITableV2;
  receiptBucket: s3.IBucket;
  /** 4 アプリ共通のログイン。API はこのプールが kakeibo のクライアントに出したトークンだけを通す */
  sharedAuth: SharedAuth;
  /** CORS で許す配信元。本番のドメインと開発用の localhost */
  allowedOrigins: string[];
  /** OCR が Claude API に入るための ID 連携。無ければ OCR は Bedrock だけで読む */
  anthropicFederation?: AnthropicFederation;
  /**
   * Yahoo!メールを Muse Mail へコピーする中継（mail-relay）の送り主のドメイン。家計簿のゾーン（DNS スタック）を渡す。
   * 無ければ中継を作らない（SES のドメイン認証に、ゾーンへ DKIM のレコードを書く必要があるため）
   */
  mailRelayZone?: { hostedZoneId: string; zoneName: string };
}

export class ApiStack extends cdk.Stack {
  public readonly httpApi: apigwv2.HttpApi;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const prefix = `sakekasu-kakeibo-${props.envName}`;

    // 関数の共通の設定（実行環境・バンドル・ロググループ）は app-function.ts にある。論理 ID は第 2 引数のまま
    const { fn: apiFunction } = appFunction(this, 'ApiFunction', {
      prefix,
      key: 'api',
      logsId: 'ApiLogs',
      memorySize: 512,
      timeout: cdk.Duration.seconds(20),
      environment: {
        TABLE_NAME: props.table.tableName,
        RECEIPT_BUCKET: props.receiptBucket.bucketName,
      },
    });

    props.table.grantReadWriteData(apiFunction);
    props.receiptBucket.grantPut(apiFunction);

    /**
     * OCR は関数を分けてある。画像を運ぶので実行時間とメモリが一桁違い、
     * 同じ関数に相乗りさせると明細の読み書きまで重くなる。
     * 同時実行を絞っているのは、1 回の呼び出しが Bedrock の課金につながるため。
     *
     * API Gateway からは呼ばない。api の関数がジョブを積んで非同期で呼び、結果はテーブルの
     * ジョブの行に書かせる（infra/lambda/shared/ocr-job.ts）。再試行を 0 にしているのは、
     * 落ちたときに同じ画像を読み直してモデルの課金を重ねないため。失敗はジョブに書いて画面に返す。
     */
    const ocrFunctionName = `${prefix}-ocr-receipt`;
    const ocrLogGroup = lambdaLogGroup(this, 'OcrLogs', ocrFunctionName);

    /*
     * ロールの名前を固定するのは、Claude Console の ID 連携のルールがこのロールの ARN を
     * 照合するため（arn:aws:iam::<account>:role/sakekasu-kakeibo-{env}-ocr-receipt）。
     * CDK に任せた名前は乱数が付き、作り直すたびに変わる。名前を変えるならルールも直す。
     */
    const ocrRole = new iam.Role(this, 'OcrFunctionRole', {
      roleName: ocrFunctionName,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });

    const { fn: ocrFunction } = appFunction(this, 'OcrFunction', {
      prefix,
      key: 'ocr-receipt',
      logGroup: ocrLogGroup,
      role: ocrRole,
      memorySize: 1024,
      timeout: cdk.Duration.seconds(OCR_TIMEOUT_SECONDS),
      reservedConcurrentExecutions: 3,
      retryAttempts: 0,
      environment: {
        RECEIPT_BUCKET: props.receiptBucket.bucketName,
        TABLE_NAME: props.table.tableName,
        BEDROCK_MODEL_ID,
        ...(props.anthropicFederation
          ? {
              LLM_PROVIDER: 'anthropic',
              ANTHROPIC_MODEL_OCR,
              ANTHROPIC_FEDERATION_RULE_ID: props.anthropicFederation.ruleId,
              ANTHROPIC_ORGANIZATION_ID: props.anthropicFederation.organizationId,
              ANTHROPIC_SERVICE_ACCOUNT_ID: props.anthropicFederation.serviceAccountId,
              ...(props.anthropicFederation.workspaceId
                ? { ANTHROPIC_WORKSPACE_ID: props.anthropicFederation.workspaceId }
                : {}),
            }
          : { LLM_PROVIDER: 'bedrock' }),
      },
    });

    props.receiptBucket.grantRead(ocrFunction);

    // テーブルはジョブの行の更新だけ。明細のパーティション（USER#）には触らせない
    ocrFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:UpdateItem'],
        resources: [props.table.tableArn],
        conditions: {
          'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [`${OCR_JOB_PARTITION_PREFIX}*`] },
        },
      }),
    );

    /*
     * Claude API に入るための ID トークン（JWT）を STS からもらう権限。宛先は Anthropic だけ、
     * 寿命は OCR が頼む長さまで、署名は RS256 に絞る。JWT は短命で、Anthropic の側でも
     * ルール（発行者・このロールの ARN・宛先）に合うものしか交換されない。
     */
    if (props.anthropicFederation) {
      ocrFunction.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['sts:GetWebIdentityToken'],
          resources: ['*'],
          conditions: {
            'ForAllValues:StringEquals': { 'sts:IdentityTokenAudience': [IDENTITY_TOKEN_AUDIENCE] },
            NumericLessThanEquals: { 'sts:DurationSeconds': IDENTITY_TOKEN_SECONDS },
            StringEquals: { 'sts:SigningAlgorithm': 'RS256' },
          },
        }),
      );
    }

    apiFunction.addEnvironment('OCR_FUNCTION_NAME', ocrFunction.functionName);
    ocrFunction.grantInvoke(apiFunction);
    ocrFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          `arn:${this.partition}:bedrock:${this.region}:${this.account}:inference-profile/${BEDROCK_MODEL_ID}`,
          ...BEDROCK_INFERENCE_REGIONS.map(
            (region) => `arn:${this.partition}:bedrock:${region}::foundation-model/${BEDROCK_FOUNDATION_MODEL_ID}`,
          ),
        ],
      }),
    );

    /**
     * カテゴリ判定の API キー。値は CDK に書かない。テンプレートにも履歴にも鍵を残さないため、
     * 入れ物だけ作ってデプロイ後に人が入れる。手順は docs/operations.md にある。
     *
     * 消えたときに作り直せる（TypeSafe のコンソールで再発行できる）ので、
     * 消す方は止めない。RETAIN のままにすると、環境を作り直したときに
     * 同じ名前が「削除待ち」で残っていて、次のデプロイが通らなくなる。
     */
    const typesafeApiKey = new secretsmanager.Secret(this, 'TypeSafeApiKey', {
      secretName: `${prefix}-typesafe-api-key`,
      description: 'カテゴリ判定（TypeSafe / Jev）の API キー。値は手で入れる',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    /**
     * カテゴリ判定も関数を分ける。理由は OCR と同じで、1 回の呼び出しが外部の課金に
     * つながるので同時実行を絞れるようにしておきたい。
     * 権限はこのシークレットの読み取りだけ。table もバケットも Bedrock も要らない。
     */
    const { fn: classifyFunction } = appFunction(this, 'ClassifyFunction', {
      prefix,
      key: 'classify',
      logsId: 'ClassifyLogs',
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      reservedConcurrentExecutions: 3,
      environment: {
        TYPESAFE_SECRET_ID: typesafeApiKey.secretArn,
        TYPESAFE_MODEL_ID,
      },
    });

    typesafeApiKey.grantRead(classifyFunction);

    const mailInbox = this.addMailInbox(prefix, props, classifyFunction);
    const mailRelay = props.mailRelayZone ? this.addMailRelay(prefix, props, props.mailRelayZone) : undefined;

    if (props.anthropicFederation) {
      this.addModelBench(prefix, props, props.anthropicFederation, typesafeApiKey);
    }

    const reportFunctionName = `${prefix}-monthly-report`;
    const reportLogGroup = lambdaLogGroup(this, 'MonthlyReportLogs', reportFunctionName);
    const { fn: reportFunction } = appFunction(this, 'MonthlyReportFunction', {
      prefix,
      key: 'monthly-report',
      logGroup: reportLogGroup,
      memorySize: 512,
      timeout: cdk.Duration.minutes(2),
      environment: { TABLE_NAME: props.table.tableName },
    });

    props.table.grantReadWriteData(reportFunction);

    // 毎月 1 日 00:00 UTC = 09:00 JST に前月分を作る
    const reportScheduleName = `${prefix}-monthly-report`;
    new events.Rule(this, 'MonthlyReportSchedule', {
      ruleName: reportScheduleName,
      description: '前月の家計簿レポートを作る',
      schedule: events.Schedule.cron({ minute: '0', hour: '0', day: '1', month: '*', year: '*' }),
      targets: [new targets.LambdaFunction(reportFunction)],
    });

    /*
     * JWT の検証は共通ログインのユーザープールに向ける。発行者（iss）がそのプール、
     * audience（aud）が kakeibo のクライアントのトークンだけを通す。ほかの 3 アプリの
     * クライアントに出たトークンは、同じプールでも aud が違うので弾かれる。
     *
     * 画面が送るのは ID トークン（aud が kakeibo のクライアント ID）。Lambda はその sub で
     * データを分けている。sub はプールごとに違うので、プールを替えるとデータの付け替えが要る
     * （旧ユーザープールから移したときの手順は docs/operations.md の「共通ログインへの切り替え（済み）」）。
     *
     * プールとクライアントは ID から引くだけで、このスタックでは作らない（共通基盤の持ち物）。
     */
    const sharedUserPool = cognito.UserPool.fromUserPoolId(this, 'SharedUserPool', props.sharedAuth.userPoolId);
    const sharedClient = cognito.UserPoolClient.fromUserPoolClientId(this, 'SharedUserPoolClient', props.sharedAuth.clientId);
    const authorizer = new HttpUserPoolAuthorizer('Authorizer', sharedUserPool, {
      userPoolClients: [sharedClient],
      userPoolRegion: userPoolRegion(props.sharedAuth.userPoolId),
    });

    this.httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: `${prefix}-api`,
      defaultAuthorizer: authorizer,
      corsPreflight: {
        allowOrigins: props.allowedOrigins,
        allowHeaders: ['authorization', 'content-type'],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.PUT,
          apigwv2.CorsHttpMethod.DELETE,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        maxAge: cdk.Duration.hours(1),
      },
    });

    const apiIntegration = new HttpLambdaIntegration('ApiIntegration', apiFunction);

    // より具体的な経路が優先されるので、カテゴリ判定だけ別の関数に向ける
    this.httpApi.addRoutes({
      path: '/classify',
      methods: [apigwv2.HttpMethod.POST],
      integration: new HttpLambdaIntegration('ClassifyIntegration', classifyFunction),
    });

    /*
     * レシートの読み取りの受け付け。中身は api の関数（ジョブを積んで OCR の関数を非同期で呼ぶ）で、
     * /{proxy+} でも届くが、流量の上限（routeSettings）は RouteKey が一致するルートにしか効かないので
     * 明示のルートにしておく。結果を聞きに来る GET /receipts/analyze/{jobId} は /{proxy+} で受ける。
     */
    this.httpApi.addRoutes({
      path: '/receipts/analyze',
      methods: [apigwv2.HttpMethod.POST],
      integration: apiIntegration,
    });

    /*
     * カテゴリ判定の経路だけ流量を絞る。1 回の呼び出しが外部の有料モデルを 10 回近く叩くので、
     * サインインした利用者がループで叩き続けると請求が青天井になる。同時実行の 3 は
     * 「同時に走る数」の上限で、回数や累計の費用は抑えない。
     *
     * 画面は取り込み 1 回・レシート 1 枚につき 1 回しか呼ばないので、毎秒 1 回・瞬間 5 回で
     * 普段の使い方には当たらない。ステージ全体ではなくこの経路だけに掛ける。
     *
     * CfnStage の routeSettings は型が any で、CDK が中のキーを CloudFormation の綴りに
     * 直さない。camelCase で書くとそのままテンプレートに出て、黙って効かなくなる。
     */
    /*
     * 下書き登録（Muse から呼ぶ）。この経路だけ JWT の検証を外す。Muse はブラウザでログインできないため。
     * 呼び手の確認は関数の中で、本文に掛けた HMAC-SHA256 の署名で行う（infra/lambda/mail-inbox/signature.ts）。
     * API Gateway の Lambda オーソライザーには本文が渡らないので、署名はオーソライザーでは確かめられない。
     */
    this.httpApi.addRoutes({
      path: '/draft-entries',
      methods: [apigwv2.HttpMethod.POST],
      integration: new HttpLambdaIntegration('MailInboxIntegration', mailInbox.fn),
      authorizer: new apigwv2.HttpNoneAuthorizer(),
    });

    const stage = this.httpApi.defaultStage!.node.defaultChild as apigwv2.CfnStage;
    stage.routeSettings = {
      'POST /classify': { ThrottlingRateLimit: CLASSIFY_RATE_LIMIT, ThrottlingBurstLimit: CLASSIFY_BURST_LIMIT },
      'POST /receipts/analyze': { ThrottlingRateLimit: OCR_START_RATE_LIMIT, ThrottlingBurstLimit: OCR_START_BURST_LIMIT },
      'POST /draft-entries': { ThrottlingRateLimit: MAIL_INBOX_RATE_LIMIT, ThrottlingBurstLimit: MAIL_INBOX_BURST_LIMIT },
    };

    /*
     * メソッドを並べて書くのは、OPTIONS をこのルートに含めないため。
     *
     * ANY は OPTIONS も拾う。するとブラウザの preflight がこのルートに入り、
     * defaultAuthorizer の JWT 検証に掛かる。preflight に Authorization ヘッダは
     * 付かないので 401 になり、ブラウザは本体のリクエストを投げずに諦める
     * （画面には「Failed to fetch」と出る）。CORS の設定とは無関係に失敗するので
     * 分かりにくい。実際 allowOrigins を直した後もこれで止まっていた。
     *
     * OPTIONS を持たせなければ、CORS を設定した API Gateway が preflight に
     * 直接 204 を返す。認証は通らない。
     */
    this.httpApi.addRoutes({
      path: '/{proxy+}',
      methods: [
        apigwv2.HttpMethod.GET,
        apigwv2.HttpMethod.POST,
        apigwv2.HttpMethod.PUT,
        apigwv2.HttpMethod.DELETE,
      ],
      integration: apiIntegration,
    });

    addApiAlarms(this, prefix, {
      httpApi: this.httpApi,
      functions: [
        { key: 'api', fn: apiFunction, what: 'API（明細・カテゴリ・上限の読み書き）' },
        { key: 'ocr-receipt', fn: ocrFunction, what: 'レシートの OCR' },
        { key: 'classify', fn: classifyFunction, what: 'カテゴリ判定（Jev）' },
        { key: 'monthly-report', fn: reportFunction, what: '月次レポート' },
        { key: 'mail-inbox', fn: mailInbox.fn, what: '下書き登録（Muse からのメール）' },
        ...(mailRelay ? [{ key: 'mail-relay', fn: mailRelay.fn, what: 'Yahoo!メールの取得と Muse への転送' }] : []),
      ],
      mailInboxLogGroup: mailInbox.logGroup,
      ...(mailRelay ? { mailRelayLogGroup: mailRelay.logGroup } : {}),
      reportLogGroup,
      reportScheduleName,
      ocrLogGroup,
      watchFallback: props.anthropicFederation !== undefined,
    });

    new cdk.CfnOutput(this, 'ApiUrl', { value: this.httpApi.apiEndpoint });
    // Muse に渡す下書き登録の URL
    new cdk.CfnOutput(this, 'MailInboxUrl', { value: `${this.httpApi.apiEndpoint}/draft-entries` });
    if (mailRelay) new cdk.CfnOutput(this, 'MailRelayFrom', { value: mailRelay.from });
    new cdk.CfnOutput(this, 'MonthlyReportFunctionName', { value: reportFunction.functionName });

    /*
     * 画面のビルドに渡すログインの値。deploy ワークフローがここから読む。
     * cdk.json の値をそのまま出しているだけだが、API が検証に使っている値と画面が使う値を
     * 同じ出どころにそろえるため、ワークフローでは cdk.json を直接読まずにこちらを読む。
     */
    new cdk.CfnOutput(this, 'AuthUserPoolId', { value: props.sharedAuth.userPoolId });
    new cdk.CfnOutput(this, 'AuthClientId', { value: props.sharedAuth.clientId });
    new cdk.CfnOutput(this, 'AuthDomain', { value: props.sharedAuth.domain });
  }

  /**
   * 下書き登録の関数と、その鍵の置き場所。経路（POST /draft-entries）は呼び出し側で足す。
   *
   * 鍵の値は CDK に書かない。入れ物だけ作り、発行した鍵を人が入れる（docs/operations.md の「下書き登録の鍵」）。
   * 中身は `{ "keys": [{ id, secret, sub, expiresAt }] }`。消えても発行し直せるので、TypeSafe の鍵と同じく消す方は止めない。
   *
   * 権限は、この鍵の読み取り、classify の関数の呼び出し（品目のカテゴリ判定）、テーブルの読み書き。
   * テーブルは利用者のパーティション（レシートを置く）と、重複の印のパーティションだけに絞る。
   * 同時実行を 2 に絞るのは、鍵が漏れたときに classify（有料のモデル）まで届く数を抑えるため。
   */
  private addMailInbox(
    prefix: string,
    props: ApiStackProps,
    classifyFunction: lambda.IFunction,
  ): { fn: lambda.IFunction; logGroup: logs.ILogGroup } {
    const keys = new secretsmanager.Secret(this, 'MailInboxKeys', {
      secretName: `${prefix}-mail-inbox-keys`,
      description: '下書き登録 API（Muse）の署名の鍵。値は手で入れる',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const logGroup = lambdaLogGroup(this, 'MailInboxLogs', `${prefix}-mail-inbox`);
    const { fn } = appFunction(this, 'MailInboxFunction', {
      prefix,
      key: 'mail-inbox',
      logGroup,
      memorySize: 512,
      timeout: cdk.Duration.seconds(25),
      reservedConcurrentExecutions: 2,
      environment: {
        TABLE_NAME: props.table.tableName,
        MAIL_INBOX_SECRET_ID: keys.secretArn,
        CLASSIFY_FUNCTION_NAME: classifyFunction.functionName,
      },
    });

    keys.grantRead(fn);
    classifyFunction.grantInvoke(fn);
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
        resources: [props.table.tableArn],
        conditions: {
          'ForAllValues:StringLike': {
            'dynamodb:LeadingKeys': [`${USER_PARTITION_PREFIX}*`, `${MAIL_INBOX_PARTITION_PREFIX}*`],
          },
        },
      }),
    );

    return { fn, logGroup };
  }

  /**
   * Yahoo!メールの中継。5 分ごとに IMAP で受信箱を見に行き、新着を全件 Muse Mail へ SES でコピーする
   * （infra/lambda/mail-relay）。Yahoo! の自動転送は転送したメールを Yahoo! 側に残さないため、こちらから読みに行く。
   *
   * - 送り主は家計簿のドメイン（relay@<ゾーン>）。SES のドメイン認証（Easy DKIM）のレコードは、CDK が
   *   家計簿のゾーンに書く。ゾーンは ID と名前から引くだけで、DNS スタックとは参照でつながない
   * - 設定（Yahoo! JAPAN ID・パスワード・送り先）は Secrets Manager に人が入れる。入れるまで関数は何もしない。
   *   パスワードは ID そのものの鍵なので、読めるのはこの関数だけにする
   * - 同時実行は 1。5 分ごとの呼び出しが重なって、同じメールを 2 回送らないため。再試行も 0
   *   （1 通ごとに進み具合を書くので、落ちても次の回が続きから送る）
   * - テーブルは進み具合の 1 行（MAILRELAY#）だけ。利用者のデータには触らない
   */
  private addMailRelay(
    prefix: string,
    props: ApiStackProps,
    zoneProps: { hostedZoneId: string; zoneName: string },
  ): { fn: lambda.IFunction; logGroup: logs.ILogGroup; from: string } {
    const zone = route53.PublicHostedZone.fromPublicHostedZoneAttributes(this, 'MailRelayZone', zoneProps);
    const identity = new ses.EmailIdentity(this, 'MailRelayIdentity', {
      identity: ses.Identity.publicHostedZone(zone),
    });
    const from = `relay@${zoneProps.zoneName}`;

    const config = new secretsmanager.Secret(this, 'MailRelayConfig', {
      secretName: `${prefix}-mail-relay-yahoo`,
      description: 'Yahoo!メールの取得（IMAP）の ID・パスワードと、転送先の Muse Mail のアドレス。値は手で入れる',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const logGroup = lambdaLogGroup(this, 'MailRelayLogs', `${prefix}-mail-relay`);
    const { fn } = appFunction(this, 'MailRelayFunction', {
      prefix,
      key: 'mail-relay',
      logGroup,
      memorySize: 1024,
      timeout: cdk.Duration.minutes(4),
      reservedConcurrentExecutions: 1,
      retryAttempts: 0,
      environment: {
        TABLE_NAME: props.table.tableName,
        MAIL_RELAY_SECRET_ID: config.secretArn,
        MAIL_RELAY_FROM: `Yahoo!メールの転送 <${from}>`,
      },
    });

    config.grantRead(fn);
    identity.grantSendEmail(fn);
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:PutItem'],
        resources: [props.table.tableArn],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [`${MAIL_RELAY_PARTITION_PREFIX}*`] } },
      }),
    );

    new events.Rule(this, 'MailRelaySchedule', {
      ruleName: `${prefix}-mail-relay`,
      description: 'Yahoo!メールの新着を Muse Mail へ転送する',
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [new targets.LambdaFunction(fn, { retryAttempts: 0 })],
    });

    return { fn, logGroup, from };
  }

  /**
   * モデルの評価（OCR とカテゴリ判定を、モデルを替えて保存済みのレシートでやり直す）。
   * 画面からも API からも呼ばない。人が `aws lambda invoke --invocation-type Event` で起こす
   * （docs/operations.md の「モデルを比べる」）。呼ばれなければ費用は掛からない。
   *
   * ロールは OCR と分ける。正解に使う保存済みのレシートを読むため、テーブルの読み取りが要り、
   * OCR のロール（ジョブの行の更新だけ）に足すと本番の読み取りの権限まで広がる。
   * 名前を固定するのは OCR と同じ理由で、Claude Console の ID 連携のルールがこのロールの ARN を照合する。
   * ルールはこのロール用に 1 つ足し、その ID を cdk.json の anthropicFederation.benchRuleId に書く
   * （ワークスペースは OCR と同じにして、利用上限を同じ枠で効かせる）。
   *
   * 同時実行は 1 にする。非同期で何本積んでも 1 本ずつ流れ（あふれた分は Lambda が最大 6 時間待たせる）、
   * 続けて積んだ評価がクレジットを並行して食い合わない。失敗しても再試行しない（課金を重ねない）。
   */
  private addModelBench(
    prefix: string,
    props: ApiStackProps,
    federation: AnthropicFederation,
    typesafeApiKey: secretsmanager.ISecret,
  ): void {
    const functionName = `${prefix}-model-bench`;
    const role = new iam.Role(this, 'ModelBenchFunctionRole', {
      roleName: functionName,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });

    const { fn } = appFunction(this, 'ModelBenchFunction', {
      prefix,
      key: 'model-bench',
      logsId: 'ModelBenchLogs',
      role,
      memorySize: 1024,
      timeout: cdk.Duration.minutes(15),
      reservedConcurrentExecutions: 1,
      retryAttempts: 0,
      maxEventAge: cdk.Duration.hours(6),
      environment: {
        TABLE_NAME: props.table.tableName,
        RECEIPT_BUCKET: props.receiptBucket.bucketName,
        // Jev を基準として並べるとき、classify の関数と同じ鍵とモデルを使う
        TYPESAFE_SECRET_ID: typesafeApiKey.secretArn,
        TYPESAFE_MODEL_ID,
        ANTHROPIC_FEDERATION_RULE_ID: federation.benchRuleId ?? federation.ruleId,
        ANTHROPIC_ORGANIZATION_ID: federation.organizationId,
        ANTHROPIC_SERVICE_ACCOUNT_ID: federation.serviceAccountId,
        ...(federation.workspaceId ? { ANTHROPIC_WORKSPACE_ID: federation.workspaceId } : {}),
      },
    });

    // 読むだけ。書き込みの権限は持たせない（評価が家計簿のデータを変えることは無い）
    props.table.grantReadData(fn);
    props.receiptBucket.grantRead(fn);
    typesafeApiKey.grantRead(fn);
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['sts:GetWebIdentityToken'],
        resources: ['*'],
        conditions: {
          'ForAllValues:StringEquals': { 'sts:IdentityTokenAudience': [IDENTITY_TOKEN_AUDIENCE] },
          NumericLessThanEquals: { 'sts:DurationSeconds': IDENTITY_TOKEN_SECONDS },
          StringEquals: { 'sts:SigningAlgorithm': 'RS256' },
        },
      }),
    );

    new cdk.CfnOutput(this, 'ModelBenchFunctionName', { value: fn.functionName });
  }
}
