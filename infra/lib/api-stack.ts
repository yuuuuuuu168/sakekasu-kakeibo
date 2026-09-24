import * as path from 'node:path';
import * as url from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpUserPoolAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import type * as cognito from 'aws-cdk-lib/aws-cognito';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, type BundlingOptions } from 'aws-cdk-lib/aws-lambda-nodejs';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';
import { lambdaLogGroup } from './log-group';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..', '..');

/**
 * OCR に使う推論プロファイルと、その振り先の基盤モデル。
 *
 * InvokeModel の認可はプロファイル本体と振り先の foundation-model の**両方**を見る。
 * プロファイルの ARN だけを許可すると、振り先に当たったリクエストだけが
 * AccessDeniedException で落ちる。この 2 つと振り先リージョンは
 * sakekasu-builder が同じアカウント（<アプリのアカウント ID> / ap-northeast-1）で実測したもので、
 * モデルを差し替えるときは次のコマンドで振り先を取り直すこと。
 *
 * ```sh
 * aws bedrock list-inference-profiles --region ap-northeast-1 \
 *   --query "inferenceProfileSummaries[?inferenceProfileId=='<profile-id>'].models"
 * ```
 */
const BEDROCK_MODEL_ID = 'jp.anthropic.claude-haiku-4-5-20251001-v1:0';
const BEDROCK_FOUNDATION_MODEL_ID = 'anthropic.claude-haiku-4-5-20251001-v1:0';
const BEDROCK_INFERENCE_REGIONS = ['ap-northeast-1', 'ap-northeast-3'];

/**
 * カテゴリ判定に使う TypeSafe のモデル。Bedrock には無いモデルなので、
 * こちらは推論プロファイルではなく TypeSafe の API を直接叩く。
 * `jev-latest` は世代が上がると中身が変わる。固定したいときは世代付きの ID に差し替える。
 */
const TYPESAFE_MODEL_ID = 'jev-latest';

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
  userPool: cognito.IUserPool;
  userPoolClient: cognito.IUserPoolClient;
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
      logGroup: lambdaLogGroup(this, 'MonthlyReportLogs', reportFunctionName),
      environment: { TABLE_NAME: props.table.tableName },
    });

    props.table.grantReadWriteData(reportFunction);

    // 毎月 1 日 00:00 UTC = 09:00 JST に前月分を作る
    new events.Rule(this, 'MonthlyReportSchedule', {
      ruleName: `${prefix}-monthly-report`,
      description: '前月の家計簿レポートを作る',
      schedule: events.Schedule.cron({ minute: '0', hour: '0', day: '1', month: '*', year: '*' }),
      targets: [new targets.LambdaFunction(reportFunction)],
    });

    const authorizer = new HttpUserPoolAuthorizer('Authorizer', props.userPool, {
      userPoolClients: [props.userPoolClient],
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

    new cdk.CfnOutput(this, 'ApiUrl', { value: this.httpApi.apiEndpoint });
    new cdk.CfnOutput(this, 'MonthlyReportFunctionName', { value: reportFunction.functionName });
  }
}
