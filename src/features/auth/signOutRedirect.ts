/**
 * サインアウトしたあとの行き先。
 *
 * 本番ではマネージドログインの /logout でセッションを消したあと、このアプリのサインイン画面ではなく
 * 共通のポータルのトップへ帰す。4 アプリの入口はポータルなので、サインアウトもそこで終わらせる。
 * この URL は共通ログインのアプリクライアントに logout_uri として登録してある
 * （sakekasu-integrated_environment の infra/cdk.json の logoutUrls）。登録に無い URL を渡すと
 * Cognito の /logout がエラーを返すので、変えるときは向こうの登録を先に変える。
 */
export const PORTAL_URL = 'https://sakekasu-builder.com/';

/** 手元の開発サーバー（npm run dev）として扱うホスト名 */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

export type SignOutRedirect = {
  /** Amplify の redirectSignOut に並べる URL。どれも共通ログインに登録済みのもの */
  allowed: string[];
  /** signOut({ oauth: { redirectUrl } }) で選ぶ戻り先。undefined なら Amplify が同じオリジンのものを選ぶ */
  preferred: string | undefined;
};

/**
 * 今いる場所から、サインアウトの戻り先を決める。
 *
 * Amplify v6 は redirectUrl を渡さないと redirectSignOut から「同じオリジン」の URL しか選ばず、
 * 別オリジンしか無いと invalidOriginException を投げる。渡したときは redirectSignOut に
 * 完全一致で含まれていることを求める。そのため本番では一覧にポータルを足し、呼ぶ側で明示的に選ぶ。
 * 自分のルートも一覧に残しておき、redirectUrl を付けない呼び出しが来ても落ちないようにする。
 *
 * 手元（localhost）はポータルへ飛ばさず、今まで通り自分のルートへ戻す。
 */
export function signOutRedirect(location: { origin: string; hostname: string }): SignOutRedirect {
  const own = `${location.origin}/`;
  if (LOCAL_HOSTNAMES.has(location.hostname)) return { allowed: [own], preferred: undefined };
  return { allowed: [own, PORTAL_URL], preferred: PORTAL_URL };
}
