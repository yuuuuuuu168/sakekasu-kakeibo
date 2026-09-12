import * as cdk from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';

/**
 * Lambda のロググループを明示して作る。
 * CDK の `logRetention` は `Custom::LogRetention` というカスタムリソースを増やすので使わない
 * （sakekasu-builder が #129 で 6 個消したのと同じもの。カスタムリソースは
 * CloudFormation から IMPORT できず、退路を塞ぐ）。
 */
export function lambdaLogGroup(scope: Construct, id: string, functionName: string): logs.LogGroup {
  return new logs.LogGroup(scope, id, {
    logGroupName: `/aws/lambda/${functionName}`,
    retention: logs.RetentionDays.ONE_MONTH,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
}
