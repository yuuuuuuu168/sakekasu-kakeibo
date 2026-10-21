/*
 * ルート表の照合。`/transactions/:id` のような形とメソッドで 1 つ選び、`:` の部分を取り出す。
 * AWS にも環境変数にも触らない純粋な処理なので、表の中身と切り離してテストできる。
 */

export type Route<Handler> = {
  method: 'GET' | 'PUT' | 'POST' | 'DELETE';
  /** `/` で区切った形。`:` で始まる部分は値を取り出す */
  path: string;
  handle: Handler;
};

/**
 * メソッドとパスの区切り（デコード済み）に合うルートを返す。区切りの数まで一致するものだけを選び、
 * 表の上にあるものを先に見る（`/receipts/analyze` を `/receipts/:id` より先に置く、など）。
 */
export function matchRoute<Handler>(
  routes: Route<Handler>[],
  method: string,
  segments: string[],
): { route: Route<Handler>; params: Record<string, string> } | undefined {
  for (const route of routes) {
    if (route.method !== method) continue;
    const parts = route.path.split('/').filter(Boolean);
    if (parts.length !== segments.length) continue;

    const params: Record<string, string> = {};
    const matched = parts.every((part, index) => {
      if (part.startsWith(':')) {
        params[part.slice(1)] = segments[index];
        return true;
      }
      return part === segments[index];
    });
    if (matched) return { route, params };
  }
  return undefined;
}
