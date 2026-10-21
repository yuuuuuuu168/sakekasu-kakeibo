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

/*
 * レシート・列の対応・上限の検査。これまでは本文をそのまま保存していたので、壊れた形
 * （金額が文字列、品目が配列でない、他人の写真のキーなど）もそのまま入り、画面や集計が静かに狂った。
 *
 * 見るのは必須の欄と型だけにする。画面が足す欄（createdAt、notDuplicateOf、warnings など）や、
 * 先々足す欄は通す。保存済みのデータの読み方は変えない（書き込みのときだけ見る）。
 */

/** 1 枚のレシートに持たせる品目の上限。DynamoDB の 1 行（400KB）に十分収まる数 */
export const MAX_RECEIPT_ITEMS = 500;
/** 上限を持たせるカテゴリの数の上限 */
export const MAX_BUDGET_CATEGORIES = 500;

const SOURCE_KINDS = new Set(['credit', 'paypay', 'suica', 'cash', 'unknown', 'manual']);
const RECEIPT_STATUSES = new Set(['pending', 'matched', 'cash', 'discarded']);
const CURRENCIES = new Set(['JPY', 'USD']);
const SIGNS = new Set(['positive-expense', 'negative-expense']);

const isInteger = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);

/**
 * レシート。id はパスの値で上書きする（本文の id は使わない）。
 * 写真のキーは、その利用者の置き場所（receipts/{sub}/）のものだけを受け取る
 */
export function assertReceipt(value: Json, id: string, sub: string): Json {
  const where = `レシート ${id}`;
  if (typeof value.storeName !== 'string') throw new BadRequest(`${where} の店名がありません`);
  if (typeof value.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.date)) {
    throw new BadRequest(`${where} の日付が YYYY-MM-DD ではありません`);
  }
  if (!isInteger(value.total)) throw new BadRequest(`${where} の合計が整数ではありません`);
  if (typeof value.status !== 'string' || !RECEIPT_STATUSES.has(value.status)) {
    throw new BadRequest(`${where} の状態が違います`);
  }

  if (!Array.isArray(value.items)) throw new BadRequest(`${where} に品目の一覧がありません`);
  if (value.items.length > MAX_RECEIPT_ITEMS) throw new BadRequest(`${where} の品目は ${MAX_RECEIPT_ITEMS} 件までです`);
  for (const item of value.items as unknown[]) {
    if (typeof item !== 'object' || item === null) throw new BadRequest(`${where} の品目の形が違います`);
    const { name, amount, categoryId, quantity } = item as Json;
    if (typeof name !== 'string') throw new BadRequest(`${where} の品目に名前がありません`);
    if (!isInteger(amount)) throw new BadRequest(`${where} の品目「${name}」の金額が整数ではありません`);
    if (categoryId !== undefined && typeof categoryId !== 'string') {
      throw new BadRequest(`${where} の品目「${name}」のカテゴリが文字列ではありません`);
    }
    if (quantity !== undefined && (typeof quantity !== 'number' || !Number.isFinite(quantity))) {
      throw new BadRequest(`${where} の品目「${name}」の個数が数ではありません`);
    }
  }

  if (value.currency !== undefined && (typeof value.currency !== 'string' || !CURRENCIES.has(value.currency))) {
    throw new BadRequest(`${where} の通貨が違います`);
  }
  if (
    value.exchangeRate !== undefined &&
    (typeof value.exchangeRate !== 'number' || !Number.isFinite(value.exchangeRate) || value.exchangeRate <= 0)
  ) {
    throw new BadRequest(`${where} のレートが正の数ではありません`);
  }
  if (value.paidWith !== undefined && (typeof value.paidWith !== 'string' || !SOURCE_KINDS.has(value.paidWith))) {
    throw new BadRequest(`${where} の支払い方法が違います`);
  }
  if (value.txnId !== undefined && typeof value.txnId !== 'string') {
    throw new BadRequest(`${where} の明細の ID が文字列ではありません`);
  }

  const keys = [
    ...(value.imageKey !== undefined ? [value.imageKey] : []),
    ...(value.imageKeys !== undefined ? (Array.isArray(value.imageKeys) ? value.imageKeys : [value.imageKeys]) : []),
  ];
  const own = `receipts/${sub}/`;
  if (keys.some((key) => typeof key !== 'string' || !key.startsWith(own))) {
    throw new BadRequest(`${where} の写真が、この利用者の置き場所のものではありません`);
  }

  return { ...strip(value), id };
}

/** 取り込み元ごとの列の対応。sourceId はパスの値で上書きする */
export function assertMapping(value: Json, sourceId: string): Json {
  const where = `取り込み元 ${sourceId} の列の対応`;
  if (typeof value.label !== 'string') throw new BadRequest(`${where} に表示名がありません`);
  if (typeof value.source !== 'string' || !SOURCE_KINDS.has(value.source)) {
    throw new BadRequest(`${where} の取り込み元が違います`);
  }
  const mapping = value.mapping;
  if (typeof mapping !== 'object' || mapping === null) throw new BadRequest(`${where} がありません`);
  const columns = mapping as Json;
  for (const key of ['headerRowIndex', 'date', 'amount', 'merchant'] as const) {
    // 見つからない列は -1 で持つ（detectColumns）
    if (!isInteger(columns[key]) || (columns[key] as number) < -1) throw new BadRequest(`${where} の ${key} が列の位置ではありません`);
  }
  if (columns.refund !== undefined && (!isInteger(columns.refund) || columns.refund < -1)) {
    throw new BadRequest(`${where} の refund が列の位置ではありません`);
  }
  if (typeof columns.sign !== 'string' || !SIGNS.has(columns.sign)) throw new BadRequest(`${where} の符号が違います`);

  return { ...strip(value), sourceId };
}

/** 月の上限。カテゴリ ID → 0 以上の整数（円） */
export function assertLimits(value: unknown): Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new BadRequest('limits が要ります');
  const entries = Object.entries(value as Json);
  if (entries.length > MAX_BUDGET_CATEGORIES) throw new BadRequest(`上限は ${MAX_BUDGET_CATEGORIES} カテゴリまでです`);
  for (const [categoryId, limit] of entries) {
    if (categoryId === '') throw new BadRequest('上限のカテゴリが空です');
    if (!isInteger(limit) || limit < 0) throw new BadRequest(`カテゴリ ${categoryId} の上限が 0 以上の整数ではありません`);
  }
  return value as Record<string, number>;
}
