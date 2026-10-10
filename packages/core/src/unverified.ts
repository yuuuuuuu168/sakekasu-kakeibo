import { diffDays, monthOf } from './date';
import { hasImportableStatement } from './payment';
import { recurringOccurrences } from './recurring';
import type { Receipt, RecurringPayment, SourceKind, Transaction } from './types';

/**
 * 身に覚えの確かめ。カードと PayPay の利用明細のうち、手元の記録（レシート・定期支払い）の
 * どれとも突き合わない支払いを拾い、月次レポートで「これ大丈夫？」と聞く。
 * 支出の管理とは別に、カードが不正に使われていないかを見るためのもの。
 *
 * 重複検知（duplicate.ts）とは向きが逆になる。あちらは同じ支払いが 2 件あるのを消す話で、
 * こちらは明細側にだけあってレシート側に無い支払いを疑う話。レシートから作った明細を
 * 重複として消しても、レシートそのものが残っていれば突き合わせの材料になる。
 */

/** レポートに残す 1 件。レポートは保存して読むだけなので、画面に要る分だけを持たせる */
export type UnverifiedPayment = {
  id: string;
  date: string;
  amount: number;
  rawMerchant: string;
  source: SourceKind;
  sourceLabel: string;
};

/**
 * レシートと利用明細の日付の開きの上限。利用日で突き合わせるので、計上日のずれを見込んだ
 * 4 日（receipt/match.ts の MAX_DATE_GAP）までは広げない。広げるほど別の買い物の
 * レシートで不正な支払いが隠れる。日付をまたぐ深夜の利用で 1 日ずれる分だけ許す。
 */
export const VERIFY_DATE_GAP = 1;

export type UnverifiedInput = {
  /** YYYY-MM */
  month: string;
  transactions: Transaction[];
  receipts: Receipt[];
  recurring?: RecurringPayment[];
};

/** 確かめる対象か。利用明細を取り込める払い方の、レシートから作っていない支払い */
function needsCheck(txn: Transaction): boolean {
  return hasImportableStatement(txn.source) && txn.amount > 0 && txn.receiptId === undefined && !txn.confirmed;
}

/**
 * 明細の裏付けに使えるレシート。捨てたものと、もう別の明細に紐付いたものは使わない。
 * 払い方を選んで明細にしたレシートは、払い方が明細と同じか「不明」のときだけ使う。
 * 現金で払ったレシートが同じ日・同じ額のカードの支払いを隠さないように。
 */
function canVouch(receipt: Receipt, txn: Transaction): boolean {
  if (receipt.status === 'discarded' || receipt.status === 'matched') return false;
  if (receipt.status === 'cash') {
    const paidWith = receipt.paidWith ?? 'cash';
    if (paidWith !== txn.source && paidWith !== 'unknown') return false;
  }
  return receipt.total === txn.amount && Math.abs(diffDays(receipt.date, txn.date)) <= VERIFY_DATE_GAP;
}

/**
 * その月の、確かめの要る支払いを日付順に返す。裏付けになるのは次のどれか。
 * - レシートに紐付いている（receiptId）
 * - 金額が同じで利用日の近いレシートがある。1 枚のレシートは 1 件の明細にしか使わない
 * - 登録した定期支払いと突き合った
 * - 人が「身に覚えがある」と言った（confirmed）
 */
export function findUnverifiedPayments(input: UnverifiedInput): UnverifiedPayment[] {
  const { month, transactions, receipts } = input;
  const ofMonth = transactions.filter((txn) => monthOf(txn.date) === month);

  const recurringIds = new Set(
    recurringOccurrences({ month, payments: input.recurring ?? [], transactions: ofMonth })
      .map((occurrence) => occurrence.transactionId)
      .filter((id): id is string => id !== undefined),
  );

  const targets = ofMonth
    .filter((txn) => needsCheck(txn) && !recurringIds.has(txn.id))
    .sort((a, b) => (a.date === b.date ? a.id.localeCompare(b.id) : a.date.localeCompare(b.date)));

  const used = new Set<string>();
  const unverified: UnverifiedPayment[] = [];
  for (const txn of targets) {
    // 日付の近いレシートから使う。同じ額のレシートが並んだとき、遠い方を先に食わないように
    const voucher = receipts
      .filter((receipt) => !used.has(receipt.id) && canVouch(receipt, txn))
      .sort((a, b) => Math.abs(diffDays(a.date, txn.date)) - Math.abs(diffDays(b.date, txn.date)) || a.id.localeCompare(b.id))[0];
    if (voucher) {
      used.add(voucher.id);
      continue;
    }
    unverified.push({
      id: txn.id,
      date: txn.date,
      amount: txn.amount,
      rawMerchant: txn.rawMerchant,
      source: txn.source,
      sourceLabel: txn.sourceLabel,
    });
  }
  return unverified;
}

/** 「身に覚えがある」の印を付けた明細を返す。保存は呼ぶ側で */
export function confirmPayment(txn: Transaction): Transaction {
  return { ...txn, confirmed: true };
}
