import { DISCOUNT_ID, SHIPPING_ID, TRANSFER_ID } from '../categories';
import { splitsFromReceipt } from './split';
import type { Receipt, ReceiptItem, Split, Transaction } from '../types';

/**
 * 値引きのカテゴリを足す前に保存した明細とレシートを、値引きへ付け替える。
 *
 * 前は値引きの置き場が無かったので、負の行は 2 通りの形で残っている。
 *
 * 1. 行のまま、食費などのカテゴリが付いている（OCR や判定、人が仮に選んだもの）。
 *    この行のカテゴリだけを値引きに替える。金額には触らない
 * 2. 未分類だった値引きが、品目の金額に配られて行として消えている（前の `splitsFromReceipt`）。
 *    つながっているレシートから内訳を組み直す。品目は値引き前の額に戻り、値引きの行が立つ
 *
 * 2 は内訳を丸ごと作り直すので、レシートを当てた後に人が内訳を直した明細には使わない。
 * レシートの品目と、品目名とカテゴリが並びごと一致するものだけを手つかずとみなす。
 *
 * 配送料と振替の負の行はそのまま残す。配送料は送料無料の相殺で、振替は人がわざわざ選んだもの。
 */
const KEEP = new Set([DISCOUNT_ID, SHIPPING_ID, TRANSFER_ID]);

function misfiled(item: { amount: number; categoryId?: string }): boolean {
  return item.amount < 0 && !KEEP.has(item.categoryId ?? '');
}

export type DiscountRefile = {
  /** 付け替えた明細。差し替える後の形 */
  transactions: Transaction[];
  /** 品目のカテゴリを付け替えたレシート */
  receipts: Receipt[];
};

export function refileDiscounts(transactions: Transaction[], receipts: Receipt[]): DiscountRefile {
  const refiledReceipts: Receipt[] = [];
  const latest = receipts.map((receipt) => {
    if (!receipt.items.some(misfiled)) return receipt;
    const next = { ...receipt, items: receipt.items.map(refileItem) };
    refiledReceipts.push(next);
    return next;
  });

  const refiledTransactions: Transaction[] = [];
  for (const txn of transactions) {
    const receipt = latest.find((item) => item.id === txn.receiptId) ?? latest.find((item) => item.txnId === txn.id);
    const next = refileTransaction(txn, receipt);
    if (next) refiledTransactions.push(next);
  }

  return { transactions: refiledTransactions, receipts: refiledReceipts };
}

function refileItem(item: ReceiptItem): ReceiptItem {
  return misfiled(item) ? { ...item, categoryId: DISCOUNT_ID } : item;
}

function refileTransaction(txn: Transaction, receipt: Receipt | undefined): Transaction | undefined {
  // 1. 行のまま残っている値引き。品目名の付いた行だけを見る。名前の無い負の行は返金や手の調整で、値引きとは限らない
  if (txn.splits.some((split) => split.name && misfiled(split))) {
    return {
      ...txn,
      splits: txn.splits.map((split) => (split.name && misfiled(split) ? { ...split, categoryId: DISCOUNT_ID } : split)),
    };
  }

  // 2. 品目に配られて消えた値引き
  if (!receipt || !receipt.items.some((item) => item.amount < 0)) return undefined;
  if (txn.splits.some((split) => split.amount < 0)) return undefined;
  const rebuilt = splitsFromReceipt(receipt, txn.amount);
  if (!rebuilt.some((split) => split.categoryId === DISCOUNT_ID)) return undefined;
  if (!untouched(txn.splits, rebuilt)) return undefined;
  return { ...txn, splits: rebuilt };
}

/**
 * 今の内訳が、レシートから作ったまま手つかずか。値引きを配った分だけ金額はずれているので、
 * 品目名とカテゴリの並びで比べる。行が足されたり、カテゴリが直されていたりすれば手つかずではない。
 */
function untouched(current: Split[], rebuilt: Split[]): boolean {
  const goods = rebuilt.filter((split) => split.amount >= 0);
  return (
    current.length === goods.length &&
    current.every((split, index) => split.name === goods[index].name && split.categoryId === goods[index].categoryId)
  );
}
