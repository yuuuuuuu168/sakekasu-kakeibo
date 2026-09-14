import { categoryLabel, UNCATEGORIZED_ID } from './categories';
import { daysInMonth, elapsedDays, monthOf } from './date';
import { ratio } from './money';
import { recurringOccurrences, type RecurringOccurrence } from './recurring';
import type { Budget, Category, RecurringPayment, Transaction } from './types';

export type CategoryTotal = {
  categoryId: string;
  label: string;
  actual: number;
  limit: number;
  /** 上限に対する消化率。上限 0 で実績ありなら Infinity */
  usage: number;
  /** 上限超過額。超えていなければ 0 */
  over: number;
  /** このペースで月末に着地する額 */
  projected: number;
  /** このカテゴリの、その月の定期支払い。固定費なので上限には含めて数える */
  recurring: number;
};

export type MonthSummary = {
  month: string;
  total: number;
  limitTotal: number;
  projected: number;
  categories: CategoryTotal[];
  /** 内訳が未確定の明細の件数。ここが多いとカテゴリ別の数字が当てにならない */
  needsDetailCount: number;
  uncategorizedTotal: number;
  transactionCount: number;
  /** その月の定期支払いの合計。突き合った分は明細の金額で数える */
  recurringTotal: number;
  /** そのうち、まだ明細に現れていない分。着地見込みに足したのはここ */
  recurringRemaining: number;
  /** その月の定期支払いの内訳。突き合った明細があれば transactionId が入る */
  recurringOccurrences: RecurringOccurrence[];
};

export function transactionsOfMonth(transactions: Transaction[], month: string): Transaction[] {
  return transactions.filter((txn) => monthOf(txn.date) === month);
}

/** 内訳を足してカテゴリ別の実績を出す。明細の合計ではなく内訳を見るのが肝 */
export function totalsByCategory(transactions: Transaction[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const txn of transactions) {
    for (const split of txn.splits) {
      totals.set(split.categoryId, (totals.get(split.categoryId) ?? 0) + split.amount);
    }
  }
  return totals;
}

export type AggregateInput = {
  month: string;
  transactions: Transaction[];
  categories: Category[];
  budget?: Budget;
  /** 着地見込みの計算に使う今日の日付。YYYY-MM-DD */
  today: string;
  /** 登録済みの定期支払い。渡さなければ着地見込みは従来どおり日割りだけ */
  recurring?: RecurringPayment[];
};

/**
 * 着地見込みに定期支払いを足すときの二重計上について。
 *
 * 素朴に「日割りで伸ばした額 + 定期支払いの合計」にすると、既に取り込まれている定期支払いを
 * 2 回数える。そこで、定期支払いと突き合った明細は日割りの対象から外し、その額をそのまま
 * 足し直す。残り（まだ明細に現れていない回）だけを別枠で加える。式にすると
 *
 *   見込み = round((実績 − 突き合った額) × ペース) + 突き合った額 + 未発生の定期支払い
 *
 * 定期支払いを 1 件も登録していなければ、第 1 項だけが残って従来と同じ式になる。
 * 突き合った回の金額は登録額ではなく明細の金額を使う。電気代のように額が動くものを
 * 目安として登録しておくと、落ちた月からは実績の額に置き換わる。
 */
export function aggregateMonth(input: AggregateInput): MonthSummary {
  const { month, categories, budget, today } = input;
  const monthly = transactionsOfMonth(input.transactions, month);
  const totals = totalsByCategory(monthly);
  const limits = budget?.limits ?? {};

  const days = daysInMonth(month);
  const elapsed = Math.min(Math.max(elapsedDays(month, today), 1), days);
  const pace = days / elapsed;

  const occurrences = recurringOccurrences({ month, payments: input.recurring ?? [], transactions: monthly });
  const matchedIds = new Set(occurrences.map((occurrence) => occurrence.transactionId).filter((id): id is string => id !== undefined));
  // 突き合った明細はカテゴリ別の実績から一度引く。内訳が複数カテゴリに割れていても辻褄が合うよう、
  // 登録したカテゴリではなく明細の内訳をそのまま使う
  const matchedTotals = totalsByCategory(monthly.filter((txn) => matchedIds.has(txn.id)));
  const plannedTotals = new Map<string, number>();
  for (const occurrence of occurrences) {
    if (occurrence.transactionId) continue;
    plannedTotals.set(occurrence.categoryId, (plannedTotals.get(occurrence.categoryId) ?? 0) + occurrence.amount);
  }

  const ids = new Set<string>([
    ...categories.filter((c) => !c.archived).map((c) => c.id),
    ...totals.keys(),
    ...Object.keys(limits),
    ...plannedTotals.keys(),
  ]);

  const rows: CategoryTotal[] = [...ids].map((categoryId) => {
    const actual = totals.get(categoryId) ?? 0;
    const limit = limits[categoryId] ?? 0;
    const matched = matchedTotals.get(categoryId) ?? 0;
    const planned = plannedTotals.get(categoryId) ?? 0;
    return {
      categoryId,
      label: categoryLabel(categories, categoryId),
      actual,
      limit,
      // 上限が無いカテゴリでは消化率は定義できない。ratio は 0 除算を Infinity で返すが、
      // Infinity は月次レポートの保存（DynamoDB）で弾かれて throw になるため、有限の 0 に
      // する。画面は limit<=0 を「上限なし」として usage を読まず、超過は over が持つ。
      usage: limit > 0 ? ratio(actual, limit) : 0,
      over: Math.max(0, actual - limit),
      projected: Math.round((actual - matched) * pace) + matched + planned,
      recurring: matched + planned,
    };
  });

  rows.sort((a, b) => {
    if (b.actual !== a.actual) return b.actual - a.actual;
    return a.label.localeCompare(b.label, 'ja');
  });

  const total = [...totals.values()].reduce((sum, value) => sum + value, 0);
  const limitTotal = Object.values(limits).reduce((sum, value) => sum + value, 0);
  const matchedTotal = [...matchedTotals.values()].reduce((sum, value) => sum + value, 0);
  const plannedTotal = [...plannedTotals.values()].reduce((sum, value) => sum + value, 0);

  return {
    month,
    total,
    limitTotal,
    projected: Math.round((total - matchedTotal) * pace) + matchedTotal + plannedTotal,
    categories: rows,
    needsDetailCount: monthly.filter((txn) => txn.needsDetail).length,
    uncategorizedTotal: totals.get(UNCATEGORIZED_ID) ?? 0,
    transactionCount: monthly.length,
    recurringTotal: matchedTotal + plannedTotal,
    recurringRemaining: plannedTotal,
    recurringOccurrences: occurrences,
  };
}

/** 前の月の上限をそのまま持ってくる。毎月入れ直させない */
export function carryOverBudget(previous: Budget, month: string): Budget {
  return { month, limits: { ...previous.limits } };
}
