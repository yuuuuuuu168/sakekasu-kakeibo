import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { getCurrentUser, signInWithRedirect, signOut } from 'aws-amplify/auth';
import { Hub } from 'aws-amplify/utils';
import { LogIn } from 'lucide-react';
import { Button, Card } from '../../components/ui/primitives';
import { config } from '../../config';
import { signOutRedirect } from './signOutRedirect';
import { isOAuthCallback, readSsoHint } from './ssoHint';

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
 * 自動でリダイレクトせず、ボタンを押させる。戻ってきた後の失敗（期限切れのコードなど）で
 * 送り出しと失敗を繰り返す輪に入らないようにするため。
 *
 * 例外はポータルから `?sso=1` 付きで来たときだけ。共通ログインを済ませた人なので、送り出しても
 * 画面を出さずに戻ってくる。このときは未サインインと分かった時点で 1 回だけ自動で送り出す。
 * 合図は読んだ直後に history.replaceState で URL から消し、戻り先（redirect_uri）も素のルートなので、
 * 戻ってきたページには合図が無い。戻りで失敗しても、その先はボタンを押させる通常の流れになり、
 * 輪には入らない。?code / ?error が付いている（戻りの最中）ときや、サインイン済みのときは送り出さない。
 *
 * ログイン中のユーザー名やメールアドレスは画面に出さない（要らないという要望）。
 *
 * ローカルモード（設定が無いとき）は Cognito を一切呼ばず、そのまま中身を出す。
 */
export function AuthGate({ children }: { children: (signOutFn: () => Promise<void>) => ReactNode }) {
  const [phase, setPhase] = useState<Phase>(config.mode === 'remote' ? 'checking' : 'signed-in');
  const [error, setError] = useState<string | undefined>();
  // ?sso=1 で来て、まだ自動の送り出しを使っていないか。StrictMode で effect が 2 回走っても
  // 1 回目で URL から合図を消すので、ref に覚えておく
  const autoSignIn = useRef(false);

  const handleSignIn = useCallback(async () => {
    setError(undefined);
    setPhase('redirecting');
    try {
      // 成功するとページごとマネージドログインへ移るので、ここから先は戻らない
      await signInWithRedirect();
    } catch (cause) {
      if (cause instanceof Error && cause.name === ALREADY_SIGNED_IN) {
        setPhase('signed-in');
        return;
      }
      setError(describe(cause));
      setPhase('signed-out');
    }
  }, []);

  useEffect(() => {
    if (config.mode !== 'remote') return;
    let live = true;

    const { hint, cleaned } = readSsoHint(window.location);
    if (cleaned !== undefined) window.history.replaceState(window.history.state, '', cleaned);
    if (hint && !isOAuthCallback(window.location.search)) autoSignIn.current = true;

    const check = () =>
      getCurrentUser()
        .then(() => {
          if (live) setPhase('signed-in');
        })
        .catch(() => {
          if (!live) return;
          if (autoSignIn.current) {
            autoSignIn.current = false;
            void handleSignIn();
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
        setError(describe(payload.data?.error));
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
    <div className="mx-auto flex min-h-full max-w-sm items-center px-4">
      <Card className="w-full" title="sakekasu 家計簿">
        <div className="space-y-3">
          <p className="text-sm text-ink-2">sakekasu の共通ログインでサインインします。</p>
          {error && <p className="text-xs text-critical">サインインできませんでした。{error}</p>}
          <Button variant="primary" className="w-full" disabled={phase === 'redirecting'} onClick={() => void handleSignIn()}>
            <LogIn size={16} aria-hidden />
            {phase === 'redirecting' ? 'ログイン画面へ移動中…' : 'ログイン画面へ'}
          </Button>
        </div>
      </Card>
    </div>
  );
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (cause === undefined || cause === null) return '';
  return String(cause);
}
