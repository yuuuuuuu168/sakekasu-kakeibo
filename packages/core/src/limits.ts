/**
 * API が 1 回の `PUT /transactions` で受け取る明細の上限。Lambda はこれを超えると 400 を返す。
 * 画面の側はこの件数ずつに分けて送る。カテゴリの統合のように全期間の明細を付け替えると、
 * 1 ファイルの取り込みより多くなりうるため。
 */
export const MAX_TRANSACTIONS_PER_REQUEST = 2000;
