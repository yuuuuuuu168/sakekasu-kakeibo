import { asArray, type Json } from '../shared/http';

/*
 * 1 回の呼び出しごとに 1 行出すログの中身。AWS にも環境変数にも触らない純粋な処理。
 */

/** 1 回のログに中身まで並べる明細の数。取り込みは 1 回で 2,000 件まで来るので、全部並べると 1 行が大きくなりすぎる */
export const LOGGED_TRANSACTIONS = 50;

/**
 * ログに残す、保存した中身。あとから「何がどのカテゴリで保存されたか」を CloudWatch で追えるようにする。
 * 金額・品目名・店舗名は出す（利用者が出してよいと決めた）。sub とトークンは出さない。
 * 件数とカテゴリ別の行数は全件で数え、明細の中身は先頭の LOGGED_TRANSACTIONS 件まで並べる。
 */
export function describeRequest(method: string, segments: string[], body: Json): Json {
  if (method !== 'PUT') return {};
  const [resource, param] = segments;

  if (resource === 'transactions') {
    const transactions = param === undefined ? (asArray(body.transactions) as Json[]) : [{ ...body, id: param }];
    return {
      明細: transactions.length,
      内訳のカテゴリ: countCategories(transactions.flatMap((txn) => asArray(txn?.splits))),
      中身: transactions.slice(0, LOGGED_TRANSACTIONS).map(describeTransaction),
      ...(transactions.length > LOGGED_TRANSACTIONS ? { 省いた明細: transactions.length - LOGGED_TRANSACTIONS } : {}),
    };
  }
  if (resource === 'receipts' && param) {
    return {
      レシート: param,
      店: body.storeName,
      日付: body.date,
      合計: body.total,
      品目のカテゴリ: countCategories(asArray(body.items)),
      品目: asArray(body.items).map((item) => describeLine(item as Json)),
    };
  }
  if (resource === 'categories' || resource === 'rules' || resource === 'recurring') {
    return { 件数: asArray(body[resource]).length };
  }
  return {};
}

function describeTransaction(txn: Json): Json {
  return {
    id: txn?.id,
    日付: txn?.date,
    店: txn?.rawMerchant,
    金額: txn?.amount,
    ...(txn?.receiptId ? { レシート: txn.receiptId } : {}),
    内訳: asArray(txn?.splits).map((split) => describeLine(split as Json)),
  };
}

/** 内訳や品目の 1 行。[品目名, カテゴリ, 金額] の並びにして、1 行を短く保つ */
function describeLine(line: Json): unknown[] {
  return [line?.name ?? '', line?.categoryId ?? '', line?.amount];
}

/** カテゴリ ID ごとの行数。負の金額の行は別に数え、値引きがどこに入ったかを追えるようにする */
function countCategories(rows: unknown[]): Json {
  const counts: Record<string, number> = {};
  let negative = 0;
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const { categoryId, amount } = row as Json;
    const key = typeof categoryId === 'string' && categoryId !== '' ? categoryId : '(なし)';
    counts[key] = (counts[key] ?? 0) + 1;
    if (typeof amount === 'number' && amount < 0) negative += 1;
  }
  return { ...counts, ...(negative > 0 ? { 負の行: negative } : {}) };
}
