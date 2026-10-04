import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import type { Construct } from 'constructs';

/**
 * 共通基盤（sakekasu-integrated_environment）の通知先トピックの名前。
 * ここへ送ったアラームは Slack に流れる。手順と約束は共通基盤の docs/monitoring.md にある。
 */
export const SHARED_ALERT_TOPIC_NAME = 'sakekasu-integrated-alerts';

/** トピックがあるリージョン。アラームもここに置く */
export const SHARED_ALERT_REGION = 'ap-northeast-1';

/**
 * アラーム名の接頭辞。Slack の見出しに出すアプリ名は、共通基盤がこの接頭辞から引いている。
 * 外れると「不明なアプリ」と出る
 */
export const ALARM_NAME_PREFIX = 'sakekasu-kakeibo-';

/** 共通基盤のトピックの ARN。スタックの出力は参照せず、アカウント ID と固定名から組み立てる */
export function sharedAlertTopicArn(scope: Construct): string {
  return `arn:aws:sns:${SHARED_ALERT_REGION}:${cdk.Stack.of(scope).account}:${SHARED_ALERT_TOPIC_NAME}`;
}

export interface AlarmOptions {
  /** `sakekasu-kakeibo-` で始める */
  alarmName: string;
  /** 何が起きているか・まず見るところ。Slack にそのまま出る */
  description: string;
  metric: cloudwatch.IMetric;
  threshold: number;
  evaluationPeriods?: number;
  /** 既定は「しきい値以上で異常」 */
  comparisonOperator?: cloudwatch.ComparisonOperator;
  /**
   * データが無い期間の扱い。既定は NOT_BREACHING（起きたときだけ値が出る指標向け）。
   * 呼び出しの無い夜中に「データ不足」で鳴らさないため
   */
  treatMissingData?: cloudwatch.TreatMissingData;
}

/**
 * 共通基盤のトピックへ ALARM と OK の両方を送るアラームを作る。
 *
 * アラームは監視対象のリソースと同じスタックに置く。監視用のスタックを分けると、
 * 関数やテーブルをスタック間の参照で渡すことになり、片方を作り直せなくなる。
 * トピックは ARN から取り込むだけなので、共通基盤のスタックとも参照ではつながない。
 */
export class SharedAlarms {
  private readonly topic: sns.ITopic;

  constructor(private readonly scope: Construct) {
    const stack = cdk.Stack.of(scope);
    // トークン（環境を決めずに合成したスタック）のときは判定できないので通す
    if (!cdk.Token.isUnresolved(stack.region) && stack.region !== SHARED_ALERT_REGION) {
      throw new Error(
        `アラームは ${SHARED_ALERT_REGION} に置く（通知先のトピックがあるリージョン）。${stack.stackName} は ${stack.region}`,
      );
    }
    this.topic = sns.Topic.fromTopicArn(scope, 'SharedAlertTopic', sharedAlertTopicArn(scope));
  }

  add(id: string, options: AlarmOptions): cloudwatch.Alarm {
    if (!options.alarmName.startsWith(ALARM_NAME_PREFIX)) {
      throw new Error(`アラーム名は ${ALARM_NAME_PREFIX} で始める: ${options.alarmName}`);
    }

    const alarm = new cloudwatch.Alarm(this.scope, id, {
      alarmName: options.alarmName,
      alarmDescription: options.description,
      metric: options.metric,
      threshold: options.threshold,
      evaluationPeriods: options.evaluationPeriods ?? 1,
      comparisonOperator: options.comparisonOperator ?? cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: options.treatMissingData ?? cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // 復旧（OK）も送る。届かないと、直ったかどうかが Slack だけでは分からない
    const action = new actions.SnsAction(this.topic);
    alarm.addAlarmAction(action);
    alarm.addOkAction(action);
    return alarm;
  }
}
