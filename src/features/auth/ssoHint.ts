/**
 * ポータル（https://sakekasu-builder.com/apps）から来たときの合図 `?sso=1` を読む。
 *
 * ポータルを開いている人は共通ログインでサインインを済ませているので、マネージドログインへ
 * 送り出しても画面を出さずに ?code=... 付きで戻ってくる。合図があるときだけ、ボタンを
 * 押させずに送り出してよい（判断は AuthGate が行う。ここは URL を読んで整えるだけ）。
 *
 * 合図は読んだらすぐ URL から消す。再読み込みや戻り道で、もう一度効かないようにするため。
 */
export const SSO_HINT_PARAM = 'sso';

export type SsoHint = {
  /** `sso=1` が付いていたか */
  hint: boolean;
  /** `sso` を除いた URL（パス・ほかのクエリ・ハッシュはそのまま）。消すものが無ければ undefined */
  cleaned: string | undefined;
};

/**
 * `pathname + search + hash` の形の URL から合図を読み、除いた URL を返す。
 * 値が 1 以外の `sso` も、意味の無い付け足しなので一緒に消す。
 */
export function readSsoHint(location: { pathname: string; search: string; hash: string }): SsoHint {
  const params = new URLSearchParams(location.search);
  if (!params.has(SSO_HINT_PARAM)) return { hint: false, cleaned: undefined };

  const hint = params.getAll(SSO_HINT_PARAM).includes('1');
  params.delete(SSO_HINT_PARAM);
  const query = params.toString();
  return {
    hint,
    cleaned: `${location.pathname}${query ? `?${query}` : ''}${location.hash}`,
  };
}

/** マネージドログインからの戻り（?code=... か ?error=...）か */
export function isOAuthCallback(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.has('code') || params.has('error');
}
