import { describe, expect, it } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { Template } from 'aws-cdk-lib/assertions';
import { SharedAlarms } from '../lib/alarms';
import { ApiStack } from '../lib/api-stack';
import { DataStack } from '../lib/data-stack';

const account = '123456789012';
const env = { account, region: 'ap-northeast-1' };
const TOPIC_ARN = `arn:aws:sns:ap-northeast-1:${account}:sakekasu-integrated-alerts`;

function stacks() {
  // アラームの検査に Lambda の中身は要らないので esbuild のバンドルを省く。
  // stacks.test.ts と並んで走ると CPU を取り合い、vitest のワーカーが応答しなくなる
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const data = new DataStack(app, 'test-data', { envName: 'test', env, receiptRetentionDays: 90 });
  const api = new ApiStack(app, 'test-api', {
    envName: 'test',
    env,
    table: data.table,
    receiptBucket: data.receiptBucket,
    sharedAuth: { domain: 'auth.example.com', userPoolId: 'ap-northeast-1_TestPool1', clientId: 'testclientid0123456789' },
    allowedOrigins: ['https://kakeibo.sakekasu-builder.com'],
  });
  return { data: Template.fromStack(data), api: Template.fromStack(api) };
}

type AlarmProps = {
  AlarmName: string;
  AlarmDescription: string;
  AlarmActions: unknown[];
  OKActions: unknown[];
  Threshold: number;
  EvaluationPeriods: number;
  ComparisonOperator: string;
  TreatMissingData: string;
  MetricName?: string;
  Namespace?: string;
  Period?: number;
  Statistic?: string;
  Dimensions?: { Name: string; Value: unknown }[];
};

function alarmsOf(template: Template): AlarmProps[] {
  return Object.values(template.findResources('AWS::CloudWatch::Alarm')).map((r) => r.Properties as AlarmProps);
}

function byName(template: Template, name: string): AlarmProps {
  const found = alarmsOf(template).find((a) => a.AlarmName === name);
  if (!found) throw new Error(`アラーム ${name} が無い`);
  return found;
}

/** アクションの ARN を文字列に戻す（Fn::Join で組み立てられている） */
function resolveArn(action: unknown): string {
  if (typeof action === 'string') return action;
  const join = (action as { 'Fn::Join'?: [string, unknown[]] })['Fn::Join'];
  if (!join) return JSON.stringify(action);
  return join[1].map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(join[0]);
}

describe('共通基盤へ送るアラーム', () => {
  const { data, api } = stacks();
  const all = [...alarmsOf(api), ...alarmsOf(data)];

  it('全アラームが共通基盤のトピックへ ALARM と OK の両方を送る', () => {
    expect(all.length).toBeGreaterThan(0);
    for (const alarm of all) {
      expect(alarm.AlarmActions.map(resolveArn), alarm.AlarmName).toEqual([TOPIC_ARN]);
      expect(alarm.OKActions.map(resolveArn), alarm.AlarmName).toEqual([TOPIC_ARN]);
    }
  });

  it('全アラームの名前が sakekasu-kakeibo- で始まる（Slack に kakeibo と出る）', () => {
    for (const alarm of all) {
      expect(alarm.AlarmName).toMatch(/^sakekasu-kakeibo-/);
    }
  });

  it('全アラームに説明があり、データ欠損では鳴らさない', () => {
    for (const alarm of all) {
      expect(alarm.AlarmDescription, alarm.AlarmName).toMatch(/まず/);
      expect(alarm.TreatMissingData, alarm.AlarmName).toBe('notBreaching');
    }
  });

  it('トピックを作らない（共通基盤の持ち物を ARN で引くだけ）', () => {
    api.resourceCountIs('AWS::SNS::Topic', 0);
    data.resourceCountIs('AWS::SNS::Topic', 0);
  });

  it.each(['api', 'ocr-receipt', 'classify', 'monthly-report'])('%s の Errors と Throttles を 5 分で 1 以上で見る', (key) => {
    for (const [suffix, metric] of [
      ['errors', 'Errors'],
      ['throttles', 'Throttles'],
    ]) {
      const alarm = byName(api, `sakekasu-kakeibo-test-${key}-${suffix}`);
      expect(alarm).toMatchObject({
        Namespace: 'AWS/Lambda',
        MetricName: metric,
        Statistic: 'Sum',
        Period: 300,
        Threshold: 1,
        EvaluationPeriods: 1,
        ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      });
    }
  });

  it('HTTP API の 5xx を ApiId で見る', () => {
    const alarm = byName(api, 'sakekasu-kakeibo-test-api-5xx');
    expect(alarm).toMatchObject({ Namespace: 'AWS/ApiGateway', MetricName: '5xx', Period: 300, Threshold: 1 });
    expect(alarm.Dimensions?.map((d) => d.Name)).toEqual(['ApiId']);
  });

  it('月次レポートの利用者ごとの失敗をログから数え、ログの文言と合わせてある', () => {
    api.hasResourceProperties('AWS::Logs::MetricFilter', {
      FilterPattern: '"[monthly-report] failed"',
      MetricTransformations: [
        { MetricNamespace: 'sakekasu-kakeibo', MetricName: 'sakekasu-kakeibo-test-monthly-report-failures', MetricValue: '1' },
      ],
    });
    const alarm = byName(api, 'sakekasu-kakeibo-test-monthly-report-failures');
    expect(alarm).toMatchObject({ Namespace: 'sakekasu-kakeibo', Threshold: 1 });
  });

  it('月次レポートを EventBridge が呼べなかったことを見る', () => {
    const alarm = byName(api, 'sakekasu-kakeibo-test-monthly-report-invocation-failures');
    expect(alarm).toMatchObject({ Namespace: 'AWS/Events', MetricName: 'FailedInvocations', Threshold: 1 });
    expect(alarm.Dimensions).toEqual([{ Name: 'RuleName', Value: 'sakekasu-kakeibo-test-monthly-report' }]);
  });

  it.each(['Read', 'Write'])('DynamoDB の %sThrottleEvents をデータのスタックで見る', (kind) => {
    const alarm = byName(data, `sakekasu-kakeibo-test-dynamodb-${kind.toLowerCase()}-throttles`);
    expect(alarm).toMatchObject({ Namespace: 'AWS/DynamoDB', MetricName: `${kind}ThrottleEvents`, Period: 300, Threshold: 1 });
  });

  it('アラームの数（足したら docs/operations.md の一覧も直す）', () => {
    expect(alarmsOf(api)).toHaveLength(11);
    expect(alarmsOf(data)).toHaveLength(2);
  });
});

describe('SharedAlarms', () => {
  it('接頭辞の違うアラーム名を弾く', () => {
    const stack = new cdk.Stack(new cdk.App(), 'test', { env });
    const metric = new cloudwatch.Metric({ namespace: 'x', metricName: 'y' });
    expect(() => new SharedAlarms(stack).add('A', { alarmName: 'kakeibo-x', description: 'x', metric, threshold: 1 })).toThrow(
      /sakekasu-kakeibo-/,
    );
  });

  it('ap-northeast-1 以外のスタックには置かせない', () => {
    const stack = new cdk.Stack(new cdk.App(), 'test', { env: { account, region: 'us-east-1' } });
    expect(() => new SharedAlarms(stack)).toThrow(/ap-northeast-1/);
  });
});
