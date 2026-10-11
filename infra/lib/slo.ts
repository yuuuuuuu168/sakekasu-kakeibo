import * as cdk from 'aws-cdk-lib';
import * as applicationsignals from 'aws-cdk-lib/aws-applicationsignals';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import type { Construct } from 'constructs';
import type { SharedAlarms } from './alarms';

/**
 * SLO の目標達成率（%）。SLO の定義とアラームのしきい値で同じ値を使う。
 * 別々に書くと、片方だけ動かしたときに「目標は 95% なのにアラームは 90% で鳴る」のような
 * 食い違いが黙って生まれる。
 *
 * 利用者が本人だけで、呼び出しはまばら（直近 30 日で api 747 回、ocr-receipt 142 回、
 * classify 129 回）。厳しくしても数回の失敗で割り込み、鳴りっぱなしになるだけなので
 * sakekasu-builder と同じ 90% に置く。
 */
export const SLO_ATTAINMENT_GOAL = 90;

/**
 * SLO を付ける関数。`key` は関数名の末尾（`sakekasu-kakeibo-<env>-<key>`）。
 *
 * `idPrefix` は論理 ID に入る。**既存のものは変えない。** 変えると SLO が作り直され、
 * 30 日ぶんの達成率の履歴が消える。
 *
 * 月次レポート（monthly-report）は外している。呼び出しが月に 1 回なので、30 日の窓に
 * 入るのは 1 回だけで、1 回失敗すれば 0%、成功すれば 100% にしかならない。割合で見る意味が無く、
 * 失敗は monthly-report-errors / failures のアラームが 1 回目から拾う。
 */
const SLO_TARGETS = [
  { idPrefix: 'Api', key: 'api', subject: 'API（明細・カテゴリ・上限の読み書き）' },
  { idPrefix: 'OcrReceipt', key: 'ocr-receipt', subject: 'レシートの OCR' },
  { idPrefix: 'Classify', key: 'classify', subject: 'カテゴリ判定（Jev）' },
] as const;

type SloTarget = (typeof SLO_TARGETS)[number];

/**
 * 関数名・SLO 名・アラーム名を組み立てる唯一の場所。
 *
 * SLO の `name` と、アラームの `SloName` ディメンションは一致していないといけない。
 * ずれるとアラームは INSUFFICIENT_DATA のまま居座り、監視が入っているように見えて何も鳴らない。
 * 合成もデプロイも通るので気づく手立てが無い。定義側とアラーム側で別々に文字列を書かず、
 * ここを通してしか作らない（sakekasu-builder の PR #165 のレビュー指摘と同じ）。
 */
export function sloNames(prefix: string, key: string): { functionName: string; sloName: string; alarmName: string } {
  const functionName = `${prefix}-${key}`;
  return {
    functionName,
    sloName: `${functionName}-availability`,
    alarmName: `${functionName}-slo-availability`,
  };
}

/** SLO を付けている関数のキー（テストと docs の一覧の突き合わせ用） */
export const SLO_FUNCTION_KEYS: readonly string[] = SLO_TARGETS.map((t) => t.key);

/**
 * Lambda の成功率の SLO と、それを割ったときのアラームを作る。
 *
 * ## なぜ既存のアラームがあるのに要るか
 *
 * `<key>-errors` は 5 分で 1 回でも落ちれば鳴り、次の 5 分で OK に戻る。まとまって落ちたときには
 * 効くが、ぽつぽつ落ち続けているのか一度きりなのかは Slack の流れからは読み取りにくい。
 * 30 日の budget で見ると、積み上がった失敗が 1 つの信号になる。
 *
 * ## SLI を Lambda の標準メトリクスで組んでいる理由
 *
 * kakeibo の Lambda には Application Signals の計装（ADOT のレイヤー）を入れていない。
 * サービス（Type=Service、Name=関数名、Environment=lambda:default）としては自動で認識されるが、
 * `ApplicationSignals` 名前空間の Latency / Error / Fault は出ていない（2026-10-11 実測）。
 * そのためサービスオペレーションの SLI（keyAttributes + metricType）は達成率が空のままになる。
 * 代わりに `AWS/Lambda` の Invocations を総数、Errors を失敗数として渡す。
 * keyAttributes は付けない。付けなくても SLO は作れ、付けると上の空のサービスに結び付くだけ。
 *
 * Errors に出るのは、タイムアウト・メモリ不足・初期化の失敗など関数そのものが落ちたときだけ。
 * api / classify は処理の失敗を握って 500 / 502 を返し、OCR は失敗をジョブに書いて正常に終えるので、
 * それらはこの SLO には入らない（api-5xx、ocr-receipt-failures のアラームが見る）。
 * この SLO が見ているのは「関数が落ちずに返した割合」。
 *
 * ## 可用性だけを置き、所要時間を置かない理由
 *
 * request-based の SLI は「総数」と「良い（悪い）数」の 2 つのメトリクスを要する。
 * Lambda の Duration は呼び出しごとの時間の統計しか出さず、「しきい値を超えた回数」は
 * 標準メトリクスには無いので、所要時間の SLI を組めない。period-based なら Duration の p99 を
 * 期間ごとに判定できるが、呼び出しがまばらで、ほとんどの期間がデータ無しになり判定が成り立たない。
 *
 * 可用性を request-based にしているのも同じ理由。request-based は呼び出しの成功割合を
 * 直接数えるので、疎なトラフィックでも意味のある値になる。
 */
export function addAvailabilitySlos(scope: Construct, alarms: SharedAlarms, prefix: string): void {
  for (const target of SLO_TARGETS) {
    addAvailabilitySlo(scope, alarms, prefix, target);
  }
}

function addAvailabilitySlo(scope: Construct, alarms: SharedAlarms, prefix: string, target: SloTarget): void {
  const { functionName, sloName, alarmName } = sloNames(prefix, target.key);

  /** AWS/Lambda の関数単位の合計を 1 分ごとに取る */
  const lambdaSum = (id: string, metricName: string): applicationsignals.CfnServiceLevelObjective.MetricDataQueryProperty => ({
    id,
    metricStat: {
      metric: {
        namespace: 'AWS/Lambda',
        metricName,
        dimensions: [{ name: 'FunctionName', value: functionName }],
      },
      period: 60,
      stat: 'Sum',
    },
  });

  new applicationsignals.CfnServiceLevelObjective(scope, `${target.idPrefix}AvailabilitySlo`, {
    name: sloName,
    description:
      `${target.subject}の Lambda が落ちずに返した割合（30 日で ${SLO_ATTAINMENT_GOAL}%）。` +
      'ぽつぽつ落ち続ける状態を見つけるためのもの',
    // 30 日の rolling。カレンダー月にしないのは、月初に budget が戻る形だと月末の失敗を見落としやすいため
    goal: {
      attainmentGoal: SLO_ATTAINMENT_GOAL,
      interval: { rollingInterval: { duration: 30, durationUnit: 'DAY' } },
    },
    // バーンレートの参照窓。呼び出しがまばらで 1 時間窓だとほとんどがデータ無しになるので、1 日窓だけにする
    burnRateConfigurations: [{ lookBackWindowMinutes: 1440 }],
    requestBasedSli: {
      requestBasedSliMetric: {
        totalRequestCountMetric: [lambdaSum('invocations', 'Invocations')],
        monitoredRequestCountMetric: { badCountMetric: [lambdaSum('errors', 'Errors')] },
      },
    },
  });

  /*
   * SLO を割ったときのアラーム。
   *
   * バーンレートではなく達成率（AttainmentRate）を見る。バーンレートは「エラー率 ÷ (100% − 目標)」なので、
   * この規模だと 1 回の失敗で跳ね、「30 日で 1 割までは許す」という budget の設計と噛み合わない。
   * 達成率は 30 日の成功率そのものなので、1 回の失敗では動かず、失敗が積み上がったときだけ 90 を割る。
   *
   * データが無い期間は MISSING（直前の状態を保つ）。既定の NOT_BREACHING だと、
   * 達成率の値が途切れた瞬間に「復旧した」と判定され、割ったままなのに OK が Slack に届く。
   */
  alarms.add(`${target.idPrefix}AvailabilitySloBreach`, {
    alarmName,
    description:
      `${target.subject}の Lambda の成功率が 30 日で ${SLO_ATTAINMENT_GOAL}% を割りました` +
      '（1 回きりではなく、落ちた呼び出しが積み上がっています）。' +
      `まず CloudWatch Logs の /aws/lambda/${functionName} で Task timed out / Runtime.* を探し、` +
      `Application Signals の SLO ${sloName} で落ち始めた日を見る。`,
    metric: new cloudwatch.Metric({
      namespace: 'AWS/ApplicationSignals',
      metricName: 'AttainmentRate',
      dimensionsMap: { SloName: sloName },
      // 値は 30 日の rolling なので動きが遅い。細かく見ると状態が揺れるので 1 時間で均す
      period: cdk.Duration.hours(1),
      statistic: 'Average',
    }),
    threshold: SLO_ATTAINMENT_GOAL,
    // 目標を「下回ったら」異常。SharedAlarms の既定は「以上で異常」なので明示する
    comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
    treatMissingData: cloudwatch.TreatMissingData.MISSING,
  });
}
