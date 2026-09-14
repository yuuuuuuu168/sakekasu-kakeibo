import { aggregateMonth, transactionsOfMonth, type CategoryTotal } from './budget';
import { formatYen } from './money';
import { previousMonth } from './date';
import { spendingAmount, spendingOnly } from './transfer';
import type { Budget, Category, Transaction } from './types';

export type ScoldLevel = 0 | 1 | 2 | 3 | 4;

export type Scolding = {
  level: ScoldLevel;
  title: string;
  lines: string[];
};

export type MerchantTotal = {
  merchant: string;
  rawMerchant: string;
  amount: number;
  count: number;
};

export type MonthlyReport = {
  month: string;
  generatedAt: string;
  total: number;
  limitTotal: number;
  overTotal: number;
  hasLimits: boolean;
  categories: CategoryTotal[];
  /** 超過額の大きい順に最大 3 件 */
  worst: CategoryTotal[];
  previousTotal?: number;
  deltaFromPrevious?: number;
  needsDetailCount: number;
  uncategorizedTotal: number;
  topMerchants: MerchantTotal[];
  scolding: Scolding;
};

export type ReportInput = {
  month: string;
  transactions: Transaction[];
  categories: Category[];
  budget?: Budget;
  generatedAt?: string;
};

/**
 * 月次レポートを組む。毎月 1 日に Lambda が前月分を作り、画面はそれを読むだけにする。
 * 叱りの文面を固定テンプレートにしてあるのは、段階が同じなら毎月同じ言い方になるほうが
 * 先月より悪化したかどうかが伝わるから。LLM に書かせると毎月言うことが変わって比較できない。
 */
export function buildMonthlyReport(input: ReportInput): MonthlyReport {
  const { month, transactions, categories, budget } = input;
  // 締めた月のレポートなので、着地見込みの基準日は月内の最終日でよい
  const summary = aggregateMonth({ month, transactions, categories, budget, today: `${month}-28` });
  // 前月との比較も支出どうしで見る。片方にチャージが混ざると増減が嘘になる
  const previous = spendingOnly(transactionsOfMonth(transactions, previousMonth(month)));
  const previousTotal = previous.reduce((sum, txn) => sum + spendingAmount(txn), 0);

  const overCategories = summary.categories.filter((row) => row.over > 0);
  const overTotal = overCategories.reduce((sum, row) => sum + row.over, 0);
  const worst = [...overCategories].sort((a, b) => b.over - a.over).slice(0, 3);
  const hasLimits = summary.limitTotal > 0;

  return {
    month,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    total: summary.total,
    limitTotal: summary.limitTotal,
    overTotal,
    hasLimits,
    categories: summary.categories,
    worst,
    ...(previous.length > 0 ? { previousTotal, deltaFromPrevious: summary.total - previousTotal } : {}),
    needsDetailCount: summary.needsDetailCount,
    uncategorizedTotal: summary.uncategorizedTotal,
    topMerchants: topMerchants(transactionsOfMonth(transactions, month)),
    scolding: scold({
      total: summary.total,
      limitTotal: summary.limitTotal,
      overTotal,
      overCategories,
      worst,
      needsDetailCount: summary.needsDetailCount,
      hasLimits,
    }),
  };
}

/** 店舗ごとの合計。「何に散財しているか」はカテゴリより店で見たほうが早いことがある */
export function topMerchants(transactions: Transaction[], limit = 5): MerchantTotal[] {
  const totals = new Map<string, MerchantTotal>();
  for (const txn of transactions) {
    // チャージは店で使った金ではないので、その分を引いてから数える。
    // 引いて 0 以下になるのは、返金と、内訳が全部チャージの明細
    const amount = spendingAmount(txn);
    if (amount <= 0) continue;
    const found = totals.get(txn.merchant);
    if (found) {
      found.amount += amount;
      found.count += 1;
    } else {
      totals.set(txn.merchant, { merchant: txn.merchant, rawMerchant: txn.rawMerchant, amount, count: 1 });
    }
  }
  return [...totals.values()].sort((a, b) => b.amount - a.amount).slice(0, limit);
}

type ScoldInput = {
  total: number;
  limitTotal: number;
  overTotal: number;
  overCategories: CategoryTotal[];
  worst: CategoryTotal[];
  needsDetailCount: number;
  hasLimits: boolean;
};

export function determineLevel(input: ScoldInput): ScoldLevel {
  const { limitTotal, overTotal, overCategories, total } = input;
  if (!input.hasLimits) return 1;

  const doubled = overCategories.some((row) => row.limit > 0 && row.actual > row.limit * 2);
  const overRate = overTotal / limitTotal;

  if (overCategories.length === 0) return total <= limitTotal * 0.8 ? 0 : 1;
  if (doubled || overRate > 0.2) return 4;
  if (overCategories.length >= 2 || overRate > 0.05) return 3;
  return 2;
}

const TITLES: Record<ScoldLevel, string> = {
  0: '天晴れ',
  1: 'よし',
  2: 'むむ',
  3: '喝',
  4: '激怒',
};

function scold(input: ScoldInput): Scolding {
  const level = determineLevel(input);
  const lines: string[] = [];
  const head = input.worst[0];

  if (!input.hasLimits) {
    lines.push(`今月の支出は ${formatYen(input.total)}。上限を決めていないので、叱る基準がまだ無い。`);
    lines.push('カテゴリ設定から上限を入れてくれ。次の月末から本気で叱る。');
  } else if (level === 0) {
    const rate = Math.round((input.total / input.limitTotal) * 100);
    lines.push(`全カテゴリが上限内。総額 ${formatYen(input.total)} は上限の ${rate}% に収まっている。`);
    lines.push('天晴れ。この調子でいけ。');
  } else if (level === 1) {
    lines.push(`超過はゼロ。総額 ${formatYen(input.total)}、上限は ${formatYen(input.limitTotal)}。`);
    lines.push('守れてはいる。あと少し削れる余地もある。');
  } else if (level === 2 && head) {
    lines.push(`${head.label} が ${formatYen(head.over)} の超過。ほかは守れている。`);
    lines.push('一箇所だけだ。来月そこを締めれば済む。');
  } else if (level === 3) {
    const names = input.overCategories.map((row) => row.label).join('、');
    lines.push(`超過が ${input.overCategories.length} カテゴリ。${names}。合計で ${formatYen(input.overTotal)} 出ている。`);
    if (head) lines.push(`とくに ${head.label}。上限 ${formatYen(head.limit)} に対して ${formatYen(head.actual)} だ。喝。`);
  } else if (head) {
    lines.push(`総額 ${formatYen(input.total)}。上限 ${formatYen(input.limitTotal)} を ${formatYen(input.overTotal)} 超えた。`);
    lines.push(`${head.label} が ${formatYen(head.actual)}。上限の ${Math.round((head.actual / Math.max(head.limit, 1)) * 100)}% だ。`);
    lines.push('言い訳は聞かない。来月は上限を守るか、上限を上げる理由を説明しろ。');
  }

  if (input.needsDetailCount > 0) {
    lines.push(`内訳が未確定の明細が ${input.needsDetailCount} 件ある。レシートを当てるまで、この数字は甘く出ている。`);
  }

  return { level, title: TITLES[level], lines };
}
