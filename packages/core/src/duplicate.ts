import { diffDays } from './date';
import { merchantSimilarity } from './merchant';
import { MAX_DATE_GAP, dateScore } from './receipt/match';
import type { Receipt, Transaction } from './types';

/**
 * 同じ支払いが二重に計上されている組を探す。明細 ID は source を混ぜたハッシュなので、
 * 現金として保存したレシートと後から取り込んだカード明細は ID が別になり、
 * mergeImported の ID 一致では拾えない。ここはその穴を埋める。
 *
 * 拾うのは「同じ支払いが 2 件ある」形だけ。PayPay の残高チャージがカード明細に出て、
 * 同じ買い物が PayPay の利用明細にも出る形は、金額も日付も揃わないので相手にしない。
 * あれは重複ではなく口座間の振替で、別の扱いが要る。
 */

export type DuplicatePair = {
  /** 日付の古い方。同じ日なら ID の小さい方 */
  a: Transaction;
  b: Transaction;
  score: number;
  reasons: string[];
};

export type DuplicateReceiptPair = {
  a: Receipt;
  b: Receipt;
  score: number;
  reasons: string[];
};

/** 日付の開きの上限。カードの利用日と計上日のずれと同じ理由で 4 日（receipt/match.ts） */
export const MAX_DUPLICATE_DATE_GAP = MAX_DATE_GAP;

/**
 * 候補に出す下限。同じ日・同じ金額だけで 40 点入るので、そこを境目にする。
 * 正規化すると店舗名が空になる明細（数字だけの店名など）でも同日・同額なら拾いたいので、
 * これ以上は上げない。
 */
export const DUPLICATE_THRESHOLD = 40;

/** ペアの並びを内容だけで決める。同じ 2 件なら、どちらを先に渡しても同じ組になる */
function orderPair<T extends { id: string; date: string }>(x: T, y: T): [T, T] {
  if (x.date !== y.date) return x.date < y.date ? [x, y] : [y, x];
  return x.id <= y.id ? [x, y] : [y, x];
}

function merchantReason(similarity: number): string | undefined {
  if (similarity >= 1) return '店名が同じ';
  if (similarity >= 0.5) return '店名が一致';
  if (similarity > 0) return '店名が近い';
  return undefined;
}

function dateReason(gap: number): string | undefined {
  const byDate = dateScore(gap);
  if (byDate >= 40) return '同じ日';
  if (byDate > 0) return `${Math.abs(gap)}日ずれ`;
  return undefined;
}

/**
 * 2 件の明細の近さを点数にする。点の付け方は receipt/match.ts に倣う。
 * 金額の一致は候補に入る条件（必須）なので点には含めない。
 */
export function scoreDuplicate(a: Transaction, b: Transaction): DuplicatePair {
  const reasons: string[] = [];
  const gap = diffDays(a.date, b.date);

  const byDate = dateScore(gap);
  const whenReason = dateReason(gap);
  if (whenReason) reasons.push(whenReason);

  const similarity = merchantSimilarity(a.rawMerchant, b.rawMerchant);
  const byMerchant = Math.round(similarity * 40);
  const whoReason = merchantReason(similarity);
  if (whoReason) reasons.push(whoReason);

  // 現金として保存したレシートと、後から取り込んだカード明細。重複の典型がここに入る
  const bySource = a.source !== b.source ? 20 : 0;
  if (bySource > 0) reasons.push('取り込み元が違う');

  // 片方にだけレシートが付いているなら、付いていない側が二重に増えた分でありうる
  const byReceipt = (a.receiptId === undefined) !== (b.receiptId === undefined) ? 10 : 0;
  if (byReceipt > 0) reasons.push('レシートが片方だけ');

  return { a, b, score: byDate + byMerchant + bySource + byReceipt, reasons };
}

/** 一度「重複ではない」と言われた組は二度と出さない。印は両側に持たせる */
export function isNotDuplicate(a: Transaction, b: Transaction): boolean {
  return (a.notDuplicateOf?.includes(b.id) ?? false) || (b.notDuplicateOf?.includes(a.id) ?? false);
}

function rememberNotDuplicate(txn: Transaction, otherId: string): Transaction {
  const current = txn.notDuplicateOf ?? [];
  if (current.includes(otherId)) return txn;
  return { ...txn, notDuplicateOf: [...current, otherId] };
}

/** 「重複ではない」の印を両側に付けた 2 件を返す。保存は呼ぶ側で */
export function markNotDuplicate(a: Transaction, b: Transaction): [Transaction, Transaction] {
  return [rememberNotDuplicate(a, b.id), rememberNotDuplicate(b, a.id)];
}

/** 同じ組を指す文字列。画面の key に使う */
export function duplicateKey(pair: DuplicatePair | DuplicateReceiptPair): string {
  return `${pair.a.id}:${pair.b.id}`;
}

/**
 * 保存済みの明細から重複候補を探す。金額の完全一致を必須にしているのは match.ts と同じ理由で、
 * 家計簿で一番信用できる手がかりだから。符号もそのまま見るので、支払いと同額の返金は組にならない。
 *
 * 取り込みのときだけでなく画面を開くたびに全件見る。金額でバケツに分けてから中だけを突き合わせるので、
 * 明細が増えても総当たりの二乗にはならない。
 */
export function findDuplicates(transactions: Transaction[]): DuplicatePair[] {
  const byAmount = new Map<number, Transaction[]>();
  for (const txn of transactions) {
    const bucket = byAmount.get(txn.amount);
    if (bucket) bucket.push(txn);
    else byAmount.set(txn.amount, [txn]);
  }

  const pairs: DuplicatePair[] = [];
  for (const bucket of byAmount.values()) {
    for (let left = 0; left < bucket.length; left += 1) {
      for (let right = left + 1; right < bucket.length; right += 1) {
        const [a, b] = orderPair(bucket[left], bucket[right]);
        if (isNotDuplicate(a, b)) continue;
        if (Math.abs(diffDays(a.date, b.date)) > MAX_DUPLICATE_DATE_GAP) continue;
        const pair = scoreDuplicate(a, b);
        if (pair.score >= DUPLICATE_THRESHOLD) pairs.push(pair);
      }
    }
  }

  return pairs.sort((x, y) => (y.score === x.score ? duplicateKey(x).localeCompare(duplicateKey(y)) : y.score - x.score));
}

/** 新しく取り込んだ明細が絡む組だけを残す。取り込み直後に出す件数に使う */
export function duplicatesInvolving(pairs: DuplicatePair[], ids: Iterable<string>): DuplicatePair[] {
  const target = new Set(ids);
  return pairs.filter((pair) => target.has(pair.a.id) || target.has(pair.b.id));
}

function sameItems(a: Receipt, b: Receipt): boolean {
  if (a.items.length === 0 || a.items.length !== b.items.length) return false;
  return a.items.every((item, index) => item.name === b.items[index].name && item.amount === b.items[index].amount);
}

/**
 * 同じレシートを 2 回撮ったものを探す。レシート ID は撮った時刻から作るので、
 * 中身が同じでも必ず別 ID になり、ID では拾えない。
 * 捨てたレシートは相手にしない。合計の一致は明細と同じく必須。
 */
export function findDuplicateReceipts(receipts: Receipt[]): DuplicateReceiptPair[] {
  const alive = receipts.filter((receipt) => receipt.status !== 'discarded');
  // 通貨も鍵に入れる。1,200 円と 12.00 ドル（1200 セント）を同じ合計と見ない
  const byTotal = new Map<string, Receipt[]>();
  for (const receipt of alive) {
    const key = `${receipt.currency ?? 'JPY'}:${receipt.total}`;
    const bucket = byTotal.get(key);
    if (bucket) bucket.push(receipt);
    else byTotal.set(key, [receipt]);
  }

  const pairs: DuplicateReceiptPair[] = [];
  for (const bucket of byTotal.values()) {
    for (let left = 0; left < bucket.length; left += 1) {
      for (let right = left + 1; right < bucket.length; right += 1) {
        const [a, b] = orderPair(bucket[left], bucket[right]);
        const gap = diffDays(a.date, b.date);
        if (Math.abs(gap) > MAX_DUPLICATE_DATE_GAP) continue;

        const reasons: string[] = [];
        const whenReason = dateReason(gap);
        if (whenReason) reasons.push(whenReason);

        const similarity = merchantSimilarity(a.storeName, b.storeName);
        const whoReason = merchantReason(similarity);
        if (whoReason) reasons.push(whoReason);

        const byItems = sameItems(a, b) ? 20 : 0;
        if (byItems > 0) reasons.push('品目まで同じ');

        const score = dateScore(gap) + Math.round(similarity * 40) + byItems;
        if (score >= DUPLICATE_THRESHOLD) pairs.push({ a, b, score, reasons });
      }
    }
  }

  return pairs.sort((x, y) => (y.score === x.score ? duplicateKey(x).localeCompare(duplicateKey(y)) : y.score - x.score));
}
