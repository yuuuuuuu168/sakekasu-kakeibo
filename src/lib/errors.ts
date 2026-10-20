/** 例外から画面に出す一文を取り出す。Error 以外が投げられても文字列にして返す */
export function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (cause === undefined || cause === null) return '';
  return String(cause);
}
