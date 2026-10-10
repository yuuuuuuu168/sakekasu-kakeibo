import { DISCOUNT_ID, SHIPPING_ID, UNCATEGORIZED_ID } from '../categories';
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

/**
 * 合計を total に合わせ直す。ずれは金額の大きい行から順に吸収させる。
 *
 * 値引き（負の行）があるときは、全行を同じ比率（total / 今の合計）で伸び縮みさせる。
 * ずれの多くは税抜き印字の店の消費税で、税は値引きにも掛かる。金額の大きさだけで配ると、
 * 値引きの行に税の正の分が乗り、値引きが小さく見える（-20 円が -19 円になる）。
 * 比率が正にならない形（合計が 0 以下、総額が 0 以下）では符号が裏返るので、従来の配り方に戻す。
 */
export function rebalance(splits: Split[], total: number): Split[] {
  if (splits.length === 0) {
    return [{ id: 'split-1', amount: total, categoryId: UNCATEGORIZED_ID, origin: 'fallback' }];
  }
  const current = sumSplits(splits);
  const gap = total - current;
  if (gap === 0) return splits;
  const amounts = splits.map((split) => split.amount);
  const scalable = amounts.some((amount) => amount < 0) && current > 0 && total > 0;
  const shares = scalable ? scale(gap, amounts) : distribute(gap, amounts);
  return splits.map((split, index) => ({ ...split, amount: split.amount + shares[index] }));
}

/**
 * 符号つきの重みで gap を配る。重みの合計が正であることが前提（rebalance が確かめている）。
 * 小数点以下を切り捨ててから、端数の大きい行に 1 円ずつ足す。配った合計は必ず gap に一致する。
 */
function scale(gap: number, weights: number[]): number[] {
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const exact = weights.map((weight) => (gap * weight) / totalWeight);
  const floored = exact.map((value) => Math.floor(value));
  let remainder = gap - floored.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction);
  for (let cursor = 0; remainder > 0; cursor += 1, remainder -= 1) {
    floored[order[cursor % order.length].index] += 1;
  }
  return floored;
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
 * 割引（負の品目）は値引きのカテゴリの行として残す。送料無料の割引だけは
 * `settleShippingDiscounts` で配送料に寄せる。
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
    categoryId: classifyItem(item.name, item.categoryId, item.amount),
    origin: 'receipt' as const,
  }));

  return rebalance(settleShippingDiscounts(splits), total);
}

/**
 * 送料と同じ額の割引は「送料無料」なので、値引きではなく配送料に入れて相殺する。
 * 値引きに残すと、払っていない送料が配送料に、同じ額が値引きに立ってしまう。
 * それ以外の割引は値引き（または人が選んだカテゴリ）の行のまま残す。
 */
function settleShippingDiscounts(splits: Split[]): Split[] {
  const shipping = splits.filter((split) => split.categoryId === SHIPPING_ID && split.amount > 0).map((split) => split.amount);
  return splits.map((split) => {
    if (split.amount >= 0 || split.categoryId !== DISCOUNT_ID) return split;
    const offset = shipping.indexOf(-split.amount);
    if (offset < 0) return split;
    shipping.splice(offset, 1);
    return { ...split, categoryId: SHIPPING_ID };
  });
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
