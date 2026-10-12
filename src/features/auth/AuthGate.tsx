import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { getCurrentUser, signInWithRedirect, signOut } from 'aws-amplify/auth';
import { Hub } from 'aws-amplify/utils';
import { config } from '../../config';
import { PORTAL_URL, signOutRedirect } from './signOutRedirect';
import { clearAutoSignIn, hasAutoSignedIn, isOAuthCallback, isOAuthError, markAutoSignIn, stripSsoHint } from './autoSignIn';

type Phase = 'checking' | 'signed-out' | 'redirecting' | 'signed-in';

/** Amplify が投げる「もうサインイン済み」の例外の名前 */
const ALREADY_SIGNED_IN = 'UserAlreadyAuthenticatedException';


/**
 * ログインは 4 アプリ共通のマネージドログイン（auth.sakekasu-builder.com）に任せる。
 * この画面はそこへ送り出し、戻ってきたら中身を出すだけで、パスワードも MFA も扱わない。
 * MFA（認証アプリ）の登録と入力は、マネージドログインの画面が行う。
 *
 * 戻ってきたとき（URL に ?code=... が付いている）は、Amplify の OAuth の処理
 * （main.tsx で有効にしている）が認可コードをトークンに換える。終わると Hub の auth に
 * signInWithRedirect か signInWithRedirect_failure が流れるので、それを見て切り替える。
 * getCurrentUser も換え終わるのを待ってから答えるので、どちらが先に来ても同じ結果になる。
 *
 * 未サインインと分かったら、ボタンを押させずに 1 回だけ自動で送り出す（4 アプリ共通の仕様）。
 * 共通ログインを済ませた人なら、マネージドログインは画面を出さずに ?code=... 付きで戻してくる。
 * 送り出しと失敗を繰り返す輪に入らないよう、送る前に sessionStorage に印を置き、印があれば
 * 自動では送らずにサインイン画面を出す（autoSignIn.ts）。?code / ?error が付いている（戻りの最中）
 * ときも自動では送らない。印はサインインできたら消す。
 * 「パスキーでログイン」のボタンは印に関係なく、押せば必ず送り出す。
 *
 * サインイン画面は 4 アプリ共通の表紙（ポータルのトップと同じ見た目）で、OS がライトでも黒に固定する。
 * 色は index.css の .signin-cover が --sk-* をこの要素の中だけダークの値に上書きして作るので、
 * サインイン後の画面には効かない。
 *
 * ポータルが付けてくる ?sso=1 は、いまは意味が無いが URL から消す。
 *
 * ログイン中のユーザー名やメールアドレスは画面に出さない（要らないという要望）。
 *
 * ローカルモード（設定が無いとき）は Cognito を一切呼ばず、そのまま中身を出す。
 */
export function AuthGate({ children }: { children: (signOutFn: () => Promise<void>) => ReactNode }) {
  const [phase, setPhase] = useState<Phase>(config.mode === 'remote' ? 'checking' : 'signed-in');
  const [error, setError] = useState<{ detail: string } | undefined>();
  // 未サインインと分かったら自動で送り出してよいか。StrictMode で effect が 2 回走っても
  // 送り出すのは 1 回にしたいので、ref に覚えておく
  const autoSignIn = useRef(false);

  /*
   * auto のとき（自動の送り出し）は、移るまで「確認中…」のままにして表紙を出さない。
   * 出すと一瞬だけ表紙が見えてからマネージドログインへ移り、ちらついて見えるため。
   */
  const handleSignIn = useCallback(async ({ auto = false }: { auto?: boolean } = {}) => {
    setError(undefined);
    if (!auto) setPhase('redirecting');
    try {
      // 成功するとページごとマネージドログインへ移るので、ここから先は戻らない
      await signInWithRedirect();
    } catch (cause) {
      if (cause instanceof Error && cause.name === ALREADY_SIGNED_IN) {
        clearAutoSignIn();
        setPhase('signed-in');
        return;
      }
      setError({ detail: describe(cause) });
      setPhase('signed-out');
    }
  }, []);

  useEffect(() => {
    if (config.mode !== 'remote') return;
    let live = true;

    const cleaned = stripSsoHint(window.location);
    if (cleaned !== undefined) window.history.replaceState(window.history.state, '', cleaned);
    const search = window.location.search;
    // ?error= 付きの戻りは、Hub の失敗が聞き手を付ける前に流れてしまうことがあるので URL からも拾う
    if (isOAuthError(search)) setError({ detail: '' });
    if (!isOAuthCallback(search) && !hasAutoSignedIn()) autoSignIn.current = true;

    const check = () =>
      getCurrentUser()
        .then(() => {
          if (!live) return;
          clearAutoSignIn();
          setPhase('signed-in');
        })
        .catch(() => {
          if (!live) return;
          if (autoSignIn.current) {
            autoSignIn.current = false;
            markAutoSignIn();
            void handleSignIn({ auto: true });
            return;
          }
          setPhase((current) => (current === 'signed-in' ? current : 'signed-out'));
        });

    const stop = Hub.listen('auth', ({ payload }) => {
      if (!live) return;
      // 戻りの結果が出たら、自動の送り出しはもう使わない
      autoSignIn.current = false;
      if (payload.event === 'signInWithRedirect') {
        setError(undefined);
        void check();
      } else if (payload.event === 'signInWithRedirect_failure') {
        setError({ detail: describe(payload.data?.error) });
        setPhase('signed-out');
      }
    });

    void check();
    return () => {
      live = false;
      stop();
    };
  }, [handleSignIn]);

  // マネージドログインのログアウトへ送る。戻り先は本番ならポータルのトップ、手元ならこのサイトのルート
  const handleSignOut = useCallback(async () => {
    if (config.mode !== 'remote') return;
    const { preferred } = signOutRedirect(window.location);
    await signOut(preferred ? { global: false, oauth: { redirectUrl: preferred } } : undefined);
    setPhase('signed-out');
  }, []);

  if (phase === 'signed-in') return <>{children(handleSignOut)}</>;
  if (phase === 'checking') {
    return <p className="p-8 text-center text-sm text-ink-2">確認中…</p>;
  }

  return (
    <main className="signin-cover">
      <div className="signin-mark" aria-hidden="true">
        💰
      </div>
      <h1 className="signin-title">家計簿</h1>
      <div className="signin-rule" aria-hidden="true">
        ◆
      </div>
      <p className="signin-lead">レシートと明細の家計簿</p>
      <button
        type="button"
        className="signin-button"
        disabled={phase === 'redirecting'}
        onClick={() => void handleSignIn()}
      >
        パスキーでログイン
      </button>
      <p className="signin-note">
        {phase === 'redirecting' ? '共通ログインの画面へ移動しています…' : '共通ログインの画面へ移動します'}
      </p>
      {error && (
        <p className="signin-error" role="alert">
          {/* 戻りの失敗や送り出しの失敗で出す一文。狭い画面では句点で折る。理由が取れたときは小さく添える */}
          ログインできませんでした。
          <wbr />
          もう一度お試しください。
          {error.detail && <small>{error.detail}</small>}
        </p>
      )}
      <a className="signin-back" href={PORTAL_URL}>
        ← sakekasu の入口へ
      </a>
    </main>
  );
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (cause === undefined || cause === null) return '';
  return String(cause);
}
