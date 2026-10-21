import type { Json } from '../shared/http';

/*
 * 本文と URL の検証。AWS にも環境変数にも触らない純粋な処理なので、テストから直接呼べる。
 * 検証に落ちたら BadRequest を投げ、handler が 400 にする。
 */

/** 400 で返す失敗。message はそのまま画面に出る */
export class BadRequest extends Error {}

/**
 * rawPath はエンコードされたまま届く。画面は id を encodeURIComponent してパスに入れるので、
 * ここで戻してからキーにする。壊れたエンコードはそのまま使う（id として見つからないだけ）
 */
export function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function assertMonth(month: string): void {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new BadRequest('月は YYYY-MM で指定してください');
}

/** DynamoDB のキーは画面に要らないので落とす。本文に混ぜられたキーも保存に使わせない */
export function strip(item: Json): Json {
  const { pk: _pk, sk: _sk, ...rest } = item;
  return rest;
}

/**
 * 内訳の合計が明細の金額に一致していることだけは、保存の前にここでも見る。
 * 画面側（packages/core）が守っている不変条件だが、壊れた状態を保存すると
 * カテゴリ別の集計が静かに狂うので、境界で止める。
 */
export function assertTransaction(value: unknown): Json & { id: string } {
  if (typeof value !== 'object' || value === null) throw new BadRequest('明細の形が違います');
  const txn = value as Json;
  if (typeof txn.id !== 'string' || txn.id === '') throw new BadRequest('明細に id がありません');
  if (typeof txn.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(txn.date)) {
    throw new BadRequest(`明細 ${txn.id} の日付が YYYY-MM-DD ではありません`);
  }
  if (typeof txn.amount !== 'number' || !Number.isInteger(txn.amount)) {
    throw new BadRequest(`明細 ${txn.id} の金額が整数ではありません`);
  }
  if (!Array.isArray(txn.splits) || txn.splits.length === 0) {
    throw new BadRequest(`明細 ${txn.id} に内訳がありません`);
  }

  let total = 0;
  for (const split of txn.splits as Json[]) {
    if (typeof split?.amount !== 'number' || !Number.isInteger(split.amount)) {
      throw new BadRequest(`明細 ${txn.id} の内訳の金額が整数ではありません`);
    }
    if (typeof split?.categoryId !== 'string' || split.categoryId === '') {
      throw new BadRequest(`明細 ${txn.id} の内訳にカテゴリがありません`);
    }
    total += split.amount;
  }
  if (total !== txn.amount) {
    throw new BadRequest(`明細 ${txn.id} の内訳の合計 ${total} が金額 ${txn.amount} と合いません`);
  }

  // 本文の pk / sk は保存に使わない。キーは呼び出し側が sub から組み立てる
  return strip(txn) as Json & { id: string };
}
