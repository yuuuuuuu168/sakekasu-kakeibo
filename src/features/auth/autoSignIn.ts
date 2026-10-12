/**
 * 未サインインで開かれたときに、ボタンを押させずにマネージドログインへ送り出すための下まわり。
 * 送り出すかどうかの判断は AuthGate が行う。ここは URL と sessionStorage を読み書きするだけ。
 *
 * 自動で送り出すのはタブごとに 1 回だけ。送る前に sessionStorage に印を置き、戻ってきても
 * まだ未サインイン（ログイン画面で戻った・取り消した、?error= 付きで戻った等）なら、印を見て
 * 自動では送らずにサインイン画面を出す。送り出しと失敗を繰り返す輪に入らないようにするため。
 * 印はサインインできたら消す。sessionStorage なので、新しいタブではまた 1 回だけ自動で進む。
 */
export const AUTO_SIGN_IN_KEY = 'sakekasu-kakeibo:auto-sign-in';

/*
 * sessionStorage は、プライベートブラウズやサイトデータを拒否する設定で投げることがある。
 * 読めないときは「もう送った」とみなし、自動では送らない（輪に入るより、ボタンを押させる方がよい）。
 */
export function hasAutoSignedIn(): boolean {
  try {
    return window.sessionStorage.getItem(AUTO_SIGN_IN_KEY) !== null;
  } catch {
    return true;
  }
}

/** 自動で送り出す直前に呼ぶ。書けなくても送り出しは止めない（読む側が「送った」とみなす） */
export function markAutoSignIn(): void {
  try {
    window.sessionStorage.setItem(AUTO_SIGN_IN_KEY, '1');
  } catch {
    // 書けない環境では hasAutoSignedIn が true を返すので、次からは自動で送らない
  }
}

/** サインインできたら呼ぶ。次にこのタブで未サインインになったら、また 1 回だけ自動で進む */
export function clearAutoSignIn(): void {
  try {
    window.sessionStorage.removeItem(AUTO_SIGN_IN_KEY);
  } catch {
    // 消せなくても困らない。次の自動の送り出しが画面になるだけ
  }
}

/**
 * ポータル（https://sakekasu-builder.com/apps）が付けてくる `?sso=1` を URL から除く。
 *
 * 以前はこの合図があるときだけ自動で送り出していた。いまは合図が無くても送り出すので意味は無いが、
 * ポータルは付けて寄こすので、URL に残さないよう消す。値が 1 以外の `sso` も一緒に消す。
 * `pathname + search + hash` の形の URL を返し、消すものが無ければ undefined を返す。
 */
export const SSO_HINT_PARAM = 'sso';

export function stripSsoHint(location: { pathname: string; search: string; hash: string }): string | undefined {
  const params = new URLSearchParams(location.search);
  if (!params.has(SSO_HINT_PARAM)) return undefined;

  params.delete(SSO_HINT_PARAM);
  const query = params.toString();
  return `${location.pathname}${query ? `?${query}` : ''}${location.hash}`;
}

/** マネージドログインからの戻り（?code=... か ?error=...）か */
export function isOAuthCallback(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.has('code') || params.has('error');
}

/** マネージドログインから ?error=... 付きで戻ってきたか（取り消した、拒否された等） */
export function isOAuthError(search: string): boolean {
  return new URLSearchParams(search).has('error');
}
