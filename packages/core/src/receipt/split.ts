import { UNCATEGORIZED_ID } from '../categories';
import { classifyItem } from './items';
import type { Receipt, Split, Transaction } from '../types';

export function sumSplits(splits: Split[]): number {
  return splits.reduce((total, split) => total + split.amount, 0);
}

export function isBalanced(splits: Split[], total: number): boolean {
  return sumSplits(splits) === total;
}

/**
 * 残額を重みに応じて配る。最大剰余法なので、配った合計は必ず残額に一致する。
 * レシートの品目合計と請求額のずれ（消費税、値引き、ポイント）をここで吸収する。
 * 「調整」という架空の行を作らず実際の品目に乗せるのは、カテゴリ別の集計を歪めないため。
 */
export function distribute(amount: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  const totalWeight = weights.reduce((sum, weight) => sum + Math.abs(weight), 0);
  if (totalWeight === 0) {
    const shares = new Array(weights.length).fill(0);
    shares[0] = amount;
    return shares;
  }

  const exact = weights.map((weight) => (amount * Math.abs(weight)) / totalWeight);
  const floored = exact.map((value) => Math.floor(value));
  let remainder = amount - floored.reduce((sum, value) => sum + value, 0);

  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction);

  const step = remainder >= 0 ? 1 : -1;
  let cursor = 0;
  while (remainder !== 0 && order.length > 0) {
    floored[order[cursor % order.length].index] += step;
    remainder -= step;
    cursor += 1;
  }
  return floored;
}

/** 合計を total に合わせ直す。ずれは金額の大きい行から順に吸収させる */
export function rebalance(splits: Split[], total: number): Split[] {
  if (splits.length === 0) {
    return [{ id: 'split-1', amount: total, categoryId: UNCATEGORIZED_ID, origin: 'fallback' }];
  }
  const gap = total - sumSplits(splits);
  if (gap === 0) return splits;
  const shares = distribute(gap, splits.map((split) => split.amount));
  return splits.map((split, index) => ({ ...split, amount: split.amount + shares[index] }));
}

/** カテゴリを並べて均等に割る。端数は後ろの行へ寄せる */
export function splitEvenly(total: number, categoryIds: string[]): Split[] {
  if (categoryIds.length === 0) return [];
  const shares = distribute(total, categoryIds.map(() => 1));
  return categoryIds.map((categoryId, index) => ({
    id: `split-${index + 1}`,
    amount: shares[index],
    categoryId,
    origin: 'manual' as const,
  }));
}

/**
 * 画面で入れた金額で内訳を作る。最後の行は残り全額にする。
 * 入れた金額の合計が総額を超えていたら、最後の行は 0 になる。
 */
export function splitByAmounts(total: number, parts: { categoryId: string; amount?: number }[]): Split[] {
  if (parts.length === 0) return [];
  const fixed = parts.slice(0, -1).map((part) => Math.max(0, Math.round(part.amount ?? 0)));
  const last = total - fixed.reduce((sum, value) => sum + value, 0);
  const amounts = [...fixed, last];
  return parts.map((part, index) => ({
    id: `split-${index + 1}`,
    amount: amounts[index],
    categoryId: part.categoryId,
    origin: 'manual' as const,
  }));
}

/**
 * レシートの品目を明細の内訳にする。これがこの家計簿の主役。
 * 品目ごとに 1 行作るので、コンビニの 1,200 円が「おにぎり 150 / ティッシュ 250 …」に割れる。
 * 品目合計と請求額のずれは distribute で品目に按分する。
 */
export function splitsFromReceipt(receipt: Receipt, total: number): Split[] {
  const items = receipt.items.filter((item) => Number.isFinite(item.amount) && item.amount !== 0);
  if (items.length === 0) {
    return [{ id: 'split-1', amount: total, categoryId: UNCATEGORIZED_ID, origin: 'receipt' }];
  }

  const splits: Split[] = items.map((item, index) => ({
    id: `split-${index + 1}`,
    name: item.name,
    amount: Math.round(item.amount),
    categoryId: classifyItem(item.name, item.categoryId),
    origin: 'receipt' as const,
  }));

  return rebalance(splits, total);
}

/** レシートを明細に紐付ける。内訳が確定するので needsDetail は下ろす */
export function applyReceipt(txn: Transaction, receipt: Receipt): Transaction {
  return {
    ...txn,
    splits: splitsFromReceipt(receipt, txn.amount),
    needsDetail: false,
    receiptId: receipt.id,
  };
}

/** 手で内訳を差し替える。合計が合わないものは受け取らずに整える */
export function applySplits(txn: Transaction, splits: Split[]): Transaction {
  const balanced = rebalance(splits, txn.amount);
  return { ...txn, splits: balanced, needsDetail: false };
}
