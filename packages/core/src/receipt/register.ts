import { UNCATEGORIZED_ID, categoryLabel } from '../categories';
import { foreignOf, receiptYenTotal } from '../currency';
import { SOURCE_LABELS } from '../payment';
import { transactionId } from '../statement/normalize';
import type { Category, Receipt, SourceKind, Transaction } from '../types';
import { splitsFromReceipt } from './split';

/**
 * 支払い方法を選んで、レシートそのものを明細にする（明細を取り込まない支払い向け）。
 *
 * `existing` は、保存済みのレシートを直したときの、前に作った明細。渡すと ID と
 * メモ・「重複ではない」の印を引き継いで中身だけ差し替える。ID は内容から作るので、
 * 作り直すと日付や金額を直しただけで別の明細になり、前の明細が残って二重になる。
 *
 * ドルのレシートは、レシートのレート（exchangeRate）で円に直した額を明細の金額にする。
 */
export function transactionFromReceipt(receipt: Receipt, paidWith: SourceKind, existing?: Transaction): Transaction {
  const { foreign: _previous, ...base } = existing ?? {};
  const amount = receiptYenTotal(receipt);
  const foreign = foreignOf(receipt);
  return {
    ...base,
    id: existing?.id ?? transactionId(paidWith, receipt.date, amount, receipt.storeName),
    date: receipt.date,
    amount,
    rawMerchant: receipt.storeName,
    merchant: receipt.storeName,
    source: paidWith,
    sourceLabel: SOURCE_LABELS[paidWith],
    splits: splitsFromReceipt(receipt, amount),
    needsDetail: false,
    receiptId: receipt.id,
    ...(foreign ? { foreign } : {}),
  };
}

/** レシートにつながっている明細。紐付けた明細は txnId、レシートから作った明細は receiptId で引く */
export function linkedTransaction(receipt: Receipt, transactions: Transaction[]): Transaction | undefined {
  return (
    (receipt.txnId ? transactions.find((txn) => txn.id === receipt.txnId) : undefined) ??
    transactions.find((txn) => txn.receiptId === receipt.id)
  );
}

/**
 * 保存済み一覧に出すカテゴリの要約。同じカテゴリの品目が続いても 1 回だけ出し、2 つまでに絞る。
 * 「カフェ・カフェ」のように重ねると、そのぶん店名の幅が削られる。
 */
export function receiptCategorySummary(receipt: Receipt, categories: Category[]): string {
  if (receipt.items.length === 0) return '品目なし';
  const labels = [...new Set(receipt.items.map((item) => categoryLabel(categories, item.categoryId ?? UNCATEGORIZED_ID)))];
  return labels.length > 2 ? `${labels.slice(0, 2).join('・')} ほか` : labels.join('・');
}
