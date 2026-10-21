import * as cdk from 'aws-cdk-lib';
import type * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { SharedAlarms } from './alarms';
import { addAvailabilitySlos } from './slo';

const FIVE_MINUTES = cdk.Duration.minutes(5);

/**
 * ログに出る 1 行を数えて、5 分に 1 回でも出たら鳴らすアラーム。
 * 処理の失敗を握って正常に終える関数（OCR、月次レポート）は Errors に出ないので、ログの文言で拾う。
 * 文言は関数の console.error / warn と合わせる（filterId のところに出どころを書く）。
 */
function logLineAlarm(
  scope: cdk.Stack,
  alarms: SharedAlarms,
  props: {
    filterId: string;
    alarmId: string;
    logGroup: logs.ILogGroup;
    /** ログの文言（そのまま一致させる） */
    literal: string;
    /** 指標の名前とアラームの名前 */
    name: string;
    description: string;
  },
): void {
  const filter = new logs.MetricFilter(scope, props.filterId, {
    logGroup: props.logGroup,
    filterPattern: logs.FilterPattern.literal(`"${props.literal}"`),
    metricNamespace: 'sakekasu-kakeibo',
    metricName: props.name,
    metricValue: '1',
  });

  alarms.add(props.alarmId, {
    alarmName: props.name,
    description: props.description,
    metric: filter.metric({ period: FIVE_MINUTES, statistic: 'Sum' }),
    threshold: 1,
  });
}

/**
 * 共通基盤の通知先（Slack）へ送るアラーム。一覧と考え方は docs/operations.md の「監視」にある。
 *
 * 3 つの関数（api / ocr-receipt / classify）は例外を握って 500 / 502 を返すので、
 * 処理の失敗は Lambda の Errors には出ず、HTTP API の 5xx に出る。Errors に出るのは
 * タイムアウト・メモリ不足・初期化の失敗など、関数そのものが落ちたときだけ。
 * 月次レポートも利用者ごとの失敗を握って先へ進むので、ログから数える。
 *
 * スコープはスタックそのものを渡す。Construct で包むと論理 ID が変わり、SLO の履歴が消える（slo.ts）
 */
export function addApiAlarms(
  scope: cdk.Stack,
  prefix: string,
  props: {
    httpApi: apigwv2.HttpApi;
    functions: { key: string; fn: IFunction; what: string }[];
    reportLogGroup: logs.ILogGroup;
    ocrLogGroup: logs.ILogGroup;
    /** OCR が Claude API から Bedrock に読み直した回数を見るか（ID 連携があるときだけ） */
    watchFallback: boolean;
    /** 月次レポートを呼ぶ EventBridge のルール名（説明文と次元に使う。トークンにしないため文字列で渡す） */
    reportScheduleName: string;
  },
): void {
  const alarms = new SharedAlarms(scope);

  for (const { key, fn, what } of props.functions) {
    alarms.add(`${pascal(key)}ErrorsAlarm`, {
      alarmName: `${prefix}-${key}-errors`,
      description:
        `${what} の Lambda が落ちています（タイムアウト・メモリ不足・初期化の失敗など）。` +
        `まず CloudWatch Logs の /aws/lambda/${prefix}-${key} を見る。`,
      metric: fn.metricErrors({ period: FIVE_MINUTES, statistic: 'Sum' }),
      threshold: 1,
    });

    alarms.add(`${pascal(key)}ThrottlesAlarm`, {
      alarmName: `${prefix}-${key}-throttles`,
      description:
        `${what} の Lambda が同時実行の上限で弾かれています。` +
        'まず関数の同時実行数（予約の上限、アカウントの上限）と、呼び出しが急に増えていないかを見る。',
      metric: fn.metricThrottles({ period: FIVE_MINUTES, statistic: 'Sum' }),
      threshold: 1,
    });
  }

  // 30 日の成功率の SLO と、それを割ったときのアラーム。対象と理由は slo.ts にある
  addAvailabilitySlos(scope, alarms, prefix);

  alarms.add('Api5xxAlarm', {
    alarmName: `${prefix}-api-5xx`,
    description:
      'HTTP API が 5xx を返しています。画面では保存・読み取りの受付・カテゴリ判定のどれかが失敗しています。' +
      'まず api / classify の CloudWatch Logs で ERROR を探す（カテゴリ判定は鍵が未設定でも 502 を返す）。' +
      '読み取りそのものの失敗はここには出ず、ocr-receipt-failures が鳴る。',
    metric: props.httpApi.metricServerError({ period: FIVE_MINUTES, statistic: 'Sum' }),
    threshold: 1,
  });

  /*
   * 読み取りの失敗。OCR の関数は失敗をジョブに書いて正常に終えるので、Errors にも 5xx にも出ない。
   * ログの行を数える。読めない画像（ピンぼけなど）でも鳴るのは、非同期にする前の 502 と同じ。
   */
  logLineAlarm(scope, alarms, {
    filterId: 'OcrFailureFilter',
    alarmId: 'OcrFailuresAlarm',
    logGroup: props.ocrLogGroup,
    // infra/lambda/ocr-receipt/index.ts の console.error の文言と合わせる
    literal: '[ocr] failed',
    name: `${prefix}-ocr-receipt-failures`,
    description:
      'レシートの読み取りに失敗しました（画面には「読み取れませんでした」と出ている）。' +
      `まず CloudWatch Logs の /aws/lambda/${prefix}-ocr-receipt で「[ocr] failed」を探す。` +
      '読めない画像なら放っておいてよい。モデルの権限やクォータのエラーなら直す。',
  });

  /*
   * OCR が Claude API から Bedrock に読み直した回数。読み取り自体は成功しているので
   * ocr-receipt-failures には出ない。残高切れ（credit_balance）・ID 連携の失敗（authentication,
   * credentials）・障害のどれかで、続くなら Bedrock の課金に切り替わっている。
   */
  if (props.watchFallback) {
    logLineAlarm(scope, alarms, {
      filterId: 'OcrFallbackFilter',
      alarmId: 'OcrFallbacksAlarm',
      logGroup: props.ocrLogGroup,
      // infra/lambda/ocr-receipt/llm.ts の console.warn の文言と合わせる
      literal: '[ocr] fallback',
      name: `${prefix}-ocr-receipt-fallbacks`,
      description:
        'レシートの読み取りが Claude API で失敗し、Bedrock で読み直しました（読み取りは続いている）。' +
        `まず CloudWatch Logs の /aws/lambda/${prefix}-ocr-receipt で「[ocr] fallback」を探し、errorType を見る。` +
        'credit_balance なら Claude Console のクレジット、authentication / credentials なら ID 連携の設定' +
        '（docs/operations.md の「Claude API の ID 連携」）を疑う。',
    });
  }

  /*
   * 月次レポートの失敗は 2 通り拾う。
   * - 利用者ごとの失敗: 関数は握って先へ進み、正常終了する。ログの行を数える
   * - そもそも呼べなかった: EventBridge の FailedInvocations（権限が外れた、関数が無いなど）
   * 関数そのものが落ちた場合は、上の monthly-report-errors が鳴る。
   * 動かなかったこと（月 1 回の呼び出しが来なかったこと）は見ていない。月に 1 点しか出ない
   * 指標を BREACHING で見ると、残りの期間ずっと鳴り続けるため。
   */
  logLineAlarm(scope, alarms, {
    filterId: 'MonthlyReportFailureFilter',
    alarmId: 'MonthlyReportFailuresAlarm',
    logGroup: props.reportLogGroup,
    // infra/lambda/monthly-report/index.ts の console.error の文言と合わせる
    literal: '[monthly-report] failed',
    name: `${prefix}-monthly-report-failures`,
    description:
      '月次レポートの生成に失敗した利用者がいます（関数は止まらずに先へ進んでいる）。' +
      `まず CloudWatch Logs の /aws/lambda/${prefix}-monthly-report で「[monthly-report] failed」を探す。` +
      '直したら docs/operations.md の「月次レポートを手で作り直す」で作り直す。',
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
      period: FIVE_MINUTES,
      statistic: 'Sum',
    }),
    threshold: 1,
  });
}

/** `ocr-receipt` → `OcrReceipt`（論理 ID 用） */
function pascal(key: string): string {
  return key
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}
