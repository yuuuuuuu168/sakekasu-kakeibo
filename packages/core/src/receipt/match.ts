import { FOREIGN_AMOUNT_TOLERANCE, receiptCurrency, receiptYenTotal } from '../currency';
import { diffDays } from '../date';
import { merchantSimilarity } from '../merchant';
import type { Receipt, Transaction } from '../types';

export type MatchCandidate = {
  txn: Transaction;
  score: number;
  reasons: string[];
};

/** カードの利用日と計上日のずれ。国内は 1〜3 日、週末を挟んで 4 日まで見る */
export const MAX_DATE_GAP = 4;
/** これを超える候補が 1 件だけなら自動で紐付ける */
export const AUTO_MATCH_SCORE = 70;

/** 日付の近さの点。重複検知（duplicate.ts）も同じ物差しを使うので export している */
export function dateScore(gap: number): number {
  const absolute = Math.abs(gap);
  if (absolute === 0) return 40;
  if (absolute === 1) return 30;
  if (absolute === 2) return 20;
  if (absolute <= MAX_DATE_GAP) return 10;
  return 0;
}

/**
 * レシートと明細の近さを点数にする。
 * 合計金額の一致は候補に入る条件（必須）なので点には含めない。
 */
export function scoreCandidate(receipt: Receipt, txn: Transaction): MatchCandidate {
  const reasons: string[] = [];
  const gap = diffDays(txn.date, receipt.date);

  const byDate = dateScore(gap);
  if (byDate >= 40) reasons.push('同じ日');
  else if (byDate > 0) reasons.push(`${Math.abs(gap)}日ずれ`);

  const similarity = merchantSimilarity(receipt.storeName, txn.rawMerchant);
  const byMerchant = Math.round(similarity * 40);
  if (similarity >= 0.5) reasons.push('店名が一致');
  else if (similarity > 0) reasons.push('店名が近い');

  const byDetail = txn.needsDetail ? 20 : 0;
  if (byDetail > 0) reasons.push('内訳待ち');

  return { txn, score: byDate + byMerchant + byDetail, reasons };
}

/**
 * 候補を探す。合計金額が一致し、日付が MAX_DATE_GAP 以内のものだけを返す。
 * 金額の一致を必須にしているのは、家計簿で一番信用できる手がかりだから。
 *
 * ドルのレシートは円の請求額とぴったりは合わない（カード会社のレートと手数料で決まる）。
 * レシートのレートで円に直した額から FOREIGN_AMOUNT_TOLERANCE 以内を候補にし、理由に「換算で近い」と出す。
 */
export function findCandidates(receipt: Receipt, transactions: Transaction[]): MatchCandidate[] {
  const amountMatches = amountMatcher(receipt);
  return transactions
    .filter((txn) => amountMatches(txn.amount))
    .filter((txn) => Math.abs(diffDays(txn.date, receipt.date)) <= MAX_DATE_GAP)
    .filter((txn) => txn.receiptId === undefined || txn.receiptId === receipt.id)
    .map((txn) => {
      const candidate = scoreCandidate(receipt, txn);
      return receiptCurrency(receipt) === 'JPY' ? candidate : { ...candidate, reasons: ['換算で近い', ...candidate.reasons] };
    })
    .sort((a, b) => b.score - a.score);
}

function amountMatcher(receipt: Receipt): (amount: number) => boolean {
  if (receiptCurrency(receipt) === 'JPY') return (amount) => amount === receipt.total;
  const estimate = receiptYenTotal(receipt);
  const tolerance = Math.max(1, Math.round(estimate * FOREIGN_AMOUNT_TOLERANCE));
  return (amount) => amount > 0 && Math.abs(amount - estimate) <= tolerance;
}

/** 迷いの無い候補が 1 件だけのときに限って自動で紐付ける。同点が並んだら人間に選ばせる */
export function autoMatch(candidates: MatchCandidate[]): Transaction | undefined {
  const strong = candidates.filter((candidate) => candidate.score >= AUTO_MATCH_SCORE);
  return strong.length === 1 ? strong[0].txn : undefined;
}
