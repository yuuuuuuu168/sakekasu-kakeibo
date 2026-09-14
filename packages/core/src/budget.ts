import { categoryLabel, UNCATEGORIZED_ID } from './categories';
import { daysInMonth, elapsedDays, monthOf } from './date';
import { ratio } from './money';
import type { Budget, Category, Transaction } from './types';

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
};

export function aggregateMonth(input: AggregateInput): MonthSummary {
  const { month, categories, budget, today } = input;
  const monthly = transactionsOfMonth(input.transactions, month);
  const totals = totalsByCategory(monthly);
  const limits = budget?.limits ?? {};

  const days = daysInMonth(month);
  const elapsed = Math.min(Math.max(elapsedDays(month, today), 1), days);
  const pace = days / elapsed;

  const ids = new Set<string>([...categories.filter((c) => !c.archived).map((c) => c.id), ...totals.keys(), ...Object.keys(limits)]);

  const rows: CategoryTotal[] = [...ids].map((categoryId) => {
    const actual = totals.get(categoryId) ?? 0;
    const limit = limits[categoryId] ?? 0;
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
      projected: Math.round(actual * pace),
    };
  });

  rows.sort((a, b) => {
    if (b.actual !== a.actual) return b.actual - a.actual;
    return a.label.localeCompare(b.label, 'ja');
  });

  const total = [...totals.values()].reduce((sum, value) => sum + value, 0);
  const limitTotal = Object.values(limits).reduce((sum, value) => sum + value, 0);

  return {
    month,
    total,
    limitTotal,
    projected: Math.round(total * pace),
    categories: rows,
    needsDetailCount: monthly.filter((txn) => txn.needsDetail).length,
    uncategorizedTotal: totals.get(UNCATEGORIZED_ID) ?? 0,
    transactionCount: monthly.length,
  };
}

/** 前の月の上限をそのまま持ってくる。毎月入れ直させない */
export function carryOverBudget(previous: Budget, month: string): Budget {
  return { month, limits: { ...previous.limits } };
}
