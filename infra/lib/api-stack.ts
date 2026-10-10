import * as path from 'node:path';
import * as url from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpUserPoolAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, type BundlingOptions } from 'aws-cdk-lib/aws-lambda-nodejs';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';
import { SharedAlarms } from './alarms';
import { lambdaLogGroup } from './log-group';
import { userPoolRegion, type SharedAuth } from './shared-auth';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..', '..');

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
 * カテゴリ判定に使う TypeSafe のモデル。Bedrock には無いモデルなので、
 * こちらは推論プロファイルではなく TypeSafe の API を直接叩く。
 * `jev-latest` は世代が上がると中身が変わる。固定したいときは世代付きの ID に差し替える。
 */
const TYPESAFE_MODEL_ID = 'jev-latest';

/** カテゴリ判定の経路に掛ける流量の上限（毎秒の回数と瞬間の回数）。理由は経路を足すところにある */
export const CLASSIFY_RATE_LIMIT = 1;
export const CLASSIFY_BURST_LIMIT = 5;

/**
 * AWS SDK も含めて 1 ファイルに固める。
 * Node.js の実行環境にも SDK v3 は入っているが、どのパッケージがどの版で入るかは
 * AWS 側の都合で変わる。家計簿が黙って動かなくなる経路を残したくないので、
 * 使うものは全部こちらで持つ。関数あたり数 MB 増えるだけで、実害は無い。
 */
const BUNDLING: BundlingOptions = { externalModules: [], target: 'node22', minify: true, sourceMap: false };

export interface ApiStackProps extends cdk.StackProps {
  envName: string;
  table: dynamodb.ITableV2;
  receiptBucket: s3.IBucket;
  /** 4 アプリ共通のログイン。API はこのプールが kakeibo のクライアントに出したトークンだけを通す */
  sharedAuth: SharedAuth;
  /** CORS で許す配信元。本番のドメインと開発用の localhost */
  allowedOrigins: string[];
}

export class ApiStack extends cdk.Stack {
  public readonly httpApi: apigwv2.HttpApi;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const prefix = `sakekasu-kakeibo-${props.envName}`;

    const apiFunctionName = `${prefix}-api`;
    const apiFunction = new NodejsFunction(this, 'ApiFunction', {
      functionName: apiFunctionName,
      entry: path.join(repoRoot, 'infra/lambda/api/index.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(20),
      depsLockFilePath: path.join(repoRoot, 'package-lock.json'),
      bundling: BUNDLING,
      logGroup: lambdaLogGroup(this, 'ApiLogs', apiFunctionName),
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
     */
    const ocrFunctionName = `${prefix}-ocr-receipt`;
    const ocrFunction = new NodejsFunction(this, 'OcrFunction', {
      functionName: ocrFunctionName,
      entry: path.join(repoRoot, 'infra/lambda/ocr-receipt/index.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 1024,
      timeout: cdk.Duration.seconds(60),
      reservedConcurrentExecutions: 3,
      depsLockFilePath: path.join(repoRoot, 'package-lock.json'),
      bundling: BUNDLING,
      logGroup: lambdaLogGroup(this, 'OcrLogs', ocrFunctionName),
      environment: {
        RECEIPT_BUCKET: props.receiptBucket.bucketName,
        BEDROCK_MODEL_ID,
      },
    });

    props.receiptBucket.grantRead(ocrFunction);
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
    const classifyFunctionName = `${prefix}-classify`;
    const classifyFunction = new NodejsFunction(this, 'ClassifyFunction', {
      functionName: classifyFunctionName,
      entry: path.join(repoRoot, 'infra/lambda/classify/index.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      reservedConcurrentExecutions: 3,
      depsLockFilePath: path.join(repoRoot, 'package-lock.json'),
      bundling: BUNDLING,
      logGroup: lambdaLogGroup(this, 'ClassifyLogs', classifyFunctionName),
      environment: {
        TYPESAFE_SECRET_ID: typesafeApiKey.secretArn,
        TYPESAFE_MODEL_ID,
      },
    });

    typesafeApiKey.grantRead(classifyFunction);

    const reportFunctionName = `${prefix}-monthly-report`;
    const reportLogGroup = lambdaLogGroup(this, 'MonthlyReportLogs', reportFunctionName);
    const reportFunction = new NodejsFunction(this, 'MonthlyReportFunction', {
      functionName: reportFunctionName,
      entry: path.join(repoRoot, 'infra/lambda/monthly-report/index.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.minutes(2),
      depsLockFilePath: path.join(repoRoot, 'package-lock.json'),
      bundling: BUNDLING,
      logGroup: reportLogGroup,
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

    // より具体的な経路が優先されるので、OCR とカテゴリ判定だけ別の関数に向ける
    this.httpApi.addRoutes({
      path: '/receipts/analyze',
      methods: [apigwv2.HttpMethod.POST],
      integration: new HttpLambdaIntegration('OcrIntegration', ocrFunction),
    });

    this.httpApi.addRoutes({
      path: '/classify',
      methods: [apigwv2.HttpMethod.POST],
      integration: new HttpLambdaIntegration('ClassifyIntegration', classifyFunction),
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
    const stage = this.httpApi.defaultStage!.node.defaultChild as apigwv2.CfnStage;
    stage.routeSettings = {
      'POST /classify': { ThrottlingRateLimit: CLASSIFY_RATE_LIMIT, ThrottlingBurstLimit: CLASSIFY_BURST_LIMIT },
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
      integration: new HttpLambdaIntegration('ApiIntegration', apiFunction),
    });

    this.addAlarms(prefix, {
      functions: [
        { key: 'api', fn: apiFunction, what: 'API（明細・カテゴリ・上限の読み書き）' },
        { key: 'ocr-receipt', fn: ocrFunction, what: 'レシートの OCR' },
        { key: 'classify', fn: classifyFunction, what: 'カテゴリ判定（Jev）' },
        { key: 'monthly-report', fn: reportFunction, what: '月次レポート' },
      ],
      reportLogGroup,
      reportScheduleName,
    });

    new cdk.CfnOutput(this, 'ApiUrl', { value: this.httpApi.apiEndpoint });
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
   * 共通基盤の通知先（Slack）へ送るアラーム。一覧と考え方は docs/operations.md の「監視」にある。
   *
   * 3 つの関数（api / ocr-receipt / classify）は例外を握って 500 / 502 を返すので、
   * 処理の失敗は Lambda の Errors には出ず、HTTP API の 5xx に出る。Errors に出るのは
   * タイムアウト・メモリ不足・初期化の失敗など、関数そのものが落ちたときだけ。
   * 月次レポートも利用者ごとの失敗を握って先へ進むので、ログから数える。
   */
  private addAlarms(
    prefix: string,
    props: {
      functions: { key: string; fn: NodejsFunction; what: string }[];
      reportLogGroup: logs.ILogGroup;
      /** 月次レポートを呼ぶ EventBridge のルール名（説明文と次元に使う。トークンにしないため文字列で渡す） */
      reportScheduleName: string;
    },
  ): void {
    const alarms = new SharedAlarms(this);
    const fiveMinutes = cdk.Duration.minutes(5);

    for (const { key, fn, what } of props.functions) {
      alarms.add(`${pascal(key)}ErrorsAlarm`, {
        alarmName: `${prefix}-${key}-errors`,
        description:
          `${what} の Lambda が落ちています（タイムアウト・メモリ不足・初期化の失敗など）。` +
          `まず CloudWatch Logs の /aws/lambda/${prefix}-${key} を見る。`,
        metric: fn.metricErrors({ period: fiveMinutes, statistic: 'Sum' }),
        threshold: 1,
      });

      alarms.add(`${pascal(key)}ThrottlesAlarm`, {
        alarmName: `${prefix}-${key}-throttles`,
        description:
          `${what} の Lambda が同時実行の上限で弾かれています。` +
          'まず関数の同時実行数（予約の上限、アカウントの上限）と、呼び出しが急に増えていないかを見る。',
        metric: fn.metricThrottles({ period: fiveMinutes, statistic: 'Sum' }),
        threshold: 1,
      });
    }

    alarms.add('Api5xxAlarm', {
      alarmName: `${prefix}-api-5xx`,
      description:
        'HTTP API が 5xx を返しています。画面では保存・OCR・カテゴリ判定のどれかが失敗しています。' +
        'まず api / ocr-receipt / classify の CloudWatch Logs で ERROR を探す' +
        '（OCR は読めない画像でも 502、カテゴリ判定は鍵が未設定でも 502 を返す）。',
      metric: this.httpApi.metricServerError({ period: fiveMinutes, statistic: 'Sum' }),
      threshold: 1,
    });

    /*
     * 月次レポートの失敗は 2 通り拾う。
     * - 利用者ごとの失敗: 関数は握って先へ進み、正常終了する。ログの行を数える
     * - そもそも呼べなかった: EventBridge の FailedInvocations（権限が外れた、関数が無いなど）
     * 関数そのものが落ちた場合は、上の monthly-report-errors が鳴る。
     * 動かなかったこと（月 1 回の呼び出しが来なかったこと）は見ていない。月に 1 点しか出ない
     * 指標を BREACHING で見ると、残りの期間ずっと鳴り続けるため。
     */
    const reportFailures = new logs.MetricFilter(this, 'MonthlyReportFailureFilter', {
      logGroup: props.reportLogGroup,
      // infra/lambda/monthly-report/index.ts の console.error の文言と合わせる
      filterPattern: logs.FilterPattern.literal('"[monthly-report] failed"'),
      metricNamespace: 'sakekasu-kakeibo',
      metricName: `${prefix}-monthly-report-failures`,
      metricValue: '1',
    });

    alarms.add('MonthlyReportFailuresAlarm', {
      alarmName: `${prefix}-monthly-report-failures`,
      description:
        '月次レポートの生成に失敗した利用者がいます（関数は止まらずに先へ進んでいる）。' +
        `まず CloudWatch Logs の /aws/lambda/${prefix}-monthly-report で「[monthly-report] failed」を探す。` +
        '直したら docs/operations.md の「月次レポートを手で作り直す」で作り直す。',
      metric: reportFailures.metric({ period: fiveMinutes, statistic: 'Sum' }),
      threshold: 1,
    });

    alarms.add('MonthlyReportInvocationFailuresAlarm', {
      alarmName: `${prefix}-monthly-report-invocation-failures`,
      description:
        'EventBridge が月次レポートの Lambda を呼べませんでした（関数の権限・存在を疑う）。' +
        `まずルール ${props.reportScheduleName} のターゲットと、関数のリソースポリシーを見る。`,
      metric: new cloudwatch.Metric({
        namespace: 'AWS/Events',
        metricName: 'FailedInvocations',
        dimensionsMap: { RuleName: props.reportScheduleName },
        period: fiveMinutes,
        statistic: 'Sum',
      }),
      threshold: 1,
    });
  }
}

/** `ocr-receipt` → `OcrReceipt`（論理 ID 用） */
function pascal(key: string): string {
  return key
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}
