import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import { SharedAlarms } from './alarms';

export interface DataStackProps extends cdk.StackProps {
  envName: string;
  /** レシート画像の保持日数。OCR で品目を取り出した後の画像は残す意味が薄い */
  receiptRetentionDays: number;
}

/**
 * 明細とレシートの置き場所。
 * 個人の金銭情報なので、バケットは公開せず、テーブルはポイントインタイムリカバリを有効にする。
 * どちらも RemovalPolicy は RETAIN。スタックを消しても家計簿が消えないようにする。
 */
export class DataStack extends cdk.Stack {
  public readonly table: dynamodb.TableV2;
  public readonly receiptBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    this.table = new dynamodb.TableV2(this, 'Table', {
      tableName: `sakekasu-kakeibo-${props.envName}`,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.receiptBucket = new s3.Bucket(this, 'Receipts', {
      bucketName: `sakekasu-kakeibo-${props.envName}-receipts-${this.account}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: 'expire-receipt-images',
          enabled: true,
          expiration: cdk.Duration.days(props.receiptRetentionDays),
        },
      ],
      cors: [
        {
          // 署名付き URL への PUT はブラウザから直接行う
          allowedMethods: [s3.HttpMethods.PUT],
          allowedOrigins: ['*'],
          allowedHeaders: ['content-type'],
          maxAge: 3000,
        },
      ],
    });

    /*
     * テーブルの読み書きが弾かれていないか。オンデマンドなので容量の設定は無いが、
     * 急な増加やパーティションの上限で弾かれることはある。ThrottledRequests は
     * 操作（Operation）ごとの次元しか持たないので、テーブル単位で出る
     * ReadThrottleEvents / WriteThrottleEvents を見る。通知先は共通基盤のトピック。
     */
    const alarms = new SharedAlarms(this);
    const tableName = `sakekasu-kakeibo-${props.envName}`;
    for (const [kind, label] of [
      ['Read', '読み取り'],
      ['Write', '書き込み'],
    ] as const) {
      alarms.add(`Table${kind}ThrottleAlarm`, {
        alarmName: `${tableName}-dynamodb-${kind.toLowerCase()}-throttles`,
        description:
          `DynamoDB のテーブル ${tableName} の${label}がスロットリングされています。画面では保存や読み込みが失敗しています。` +
          'まず API の CloudWatch Logs と、テーブルの消費キャパシティの推移（どの時間帯に急増したか）を見る。',
        metric: new cloudwatch.Metric({
          namespace: 'AWS/DynamoDB',
          metricName: `${kind}ThrottleEvents`,
          dimensionsMap: { TableName: this.table.tableName },
          period: cdk.Duration.minutes(5),
          statistic: 'Sum',
        }),
        threshold: 1,
      });
    }

    new cdk.CfnOutput(this, 'TableName', { value: this.table.tableName });
    new cdk.CfnOutput(this, 'ReceiptBucketName', { value: this.receiptBucket.bucketName });
  }
}
