import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { confirmSignIn, getCurrentUser, signIn, signOut } from 'aws-amplify/auth';
import { Button, Card, Field, Input } from '../../components/ui/primitives';
import { config } from '../../config';

type Phase = 'checking' | 'signed-out' | 'new-password' | 'totp-setup' | 'totp' | 'signed-in';

/*
 * 認証アプリの登録に必要なもの。Amplify の AuthTOTPSetupDetails と同じ形。
 * あの型は aws-amplify のルートから出ておらず、@aws-amplify/auth は直接の依存でもないので、
 * 使う 2 つだけ自前で書く。
 */
type TotpSetup = {
  sharedSecret: string;
  getSetupUri(appName: string, accountName?: string): URL;
};

/** confirmSignIn / signIn がどちらも返す形。必要なところだけ見る */
type SignInLike = {
  isSignedIn: boolean;
  nextStep: { signInStep: string; totpSetupDetails?: TotpSetup; allowedMFATypes?: string[] };
};

/** 認証アプリに表示される発行元。ASCII に寄せてある（URI に入るため） */
const ISSUER = 'sakekasu-kakeibo';

/**
 * 利用者は本人ひとりで、Cognito のユーザーは手で 1 つ作る前提。サインアップの画面は無い。
 *
 * サインインは段が続くことがある。初回は「新しいパスワード」→「認証アプリの登録」→完了、
 * 2 回目以降は「認証アプリのコード」→完了。どの段から来ても受けられるように、
 * signIn と confirmSignIn の戻りを同じ関数（advance）で捌いている。
 *
 * MFA は必須にしてあるので、登録していないユーザーは必ず登録の段に入る。ここを画面で
 * 面倒を見ないと、サインインする手段が無くなる。
 */
export function AuthGate({ children }: { children: (signOutFn: () => Promise<void>) => ReactNode }) {
  const [phase, setPhase] = useState<Phase>(config.mode === 'remote' ? 'checking' : 'signed-in');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [setup, setSetup] = useState<TotpSetup | undefined>();
  const [qr, setQr] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (config.mode !== 'remote') return;
    getCurrentUser()
      .then(() => setPhase('signed-in'))
      .catch(() => setPhase('signed-out'));
  }, []);

  // QR は登録の段に入ってから作る。手で打てるように鍵も併記するので、失敗しても行き止まりにしない
  useEffect(() => {
    if (!setup) {
      setQr(undefined);
      return;
    }
    let live = true;
    const uri = setup.getSetupUri(ISSUER, username || undefined).toString();
    import('qrcode')
      .then((module) => (module.toDataURL ?? module.default.toDataURL)(uri, { margin: 1, width: 220 }))
      .then((url) => {
        if (live) setQr(url);
      })
      .catch(() => {
        if (live) setQr(undefined);
      });
    return () => {
      live = false;
    };
  }, [setup, username]);

  const handleSignOut = useCallback(async () => {
    if (config.mode !== 'remote') return;
    await signOut();
    setPhase('signed-out');
  }, []);

  if (phase === 'signed-in') return <>{children(handleSignOut)}</>;
  if (phase === 'checking') {
    return <p className="p-8 text-center text-sm text-ink-2">確認中…</p>;
  }

  /** 次の段へ進む。段が続くこともあるので、応答を受けたら必ずここを通す */
  const advance = async (result: SignInLike): Promise<void> => {
    if (result.isSignedIn) {
      setPhase('signed-in');
      return;
    }

    const step = result.nextStep;
    switch (step.signInStep) {
      case 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED':
        setPassword('');
        setPhase('new-password');
        return;

      case 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP':
        setSetup(step.totpSetupDetails);
        setCode('');
        setPhase('totp-setup');
        return;

      case 'CONFIRM_SIGN_IN_WITH_TOTP_CODE':
        setCode('');
        setPhase('totp');
        return;

      // 認証アプリ以外を有効にしていないので選ぶ余地が無い。人に聞かず答える
      case 'CONTINUE_SIGN_IN_WITH_MFA_SELECTION':
      case 'CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION':
        if (step.allowedMFATypes?.includes('TOTP') ?? true) {
          await advance((await confirmSignIn({ challengeResponse: 'TOTP' })) as SignInLike);
          return;
        }
        break;
    }

    setError(`この認証方法にはまだ対応していません: ${step.signInStep}`);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      if (phase === 'signed-out') {
        await advance((await signIn({ username, password })) as SignInLike);
        return;
      }
      const answer = phase === 'new-password' ? password : code;
      await advance((await confirmSignIn({ challengeResponse: answer })) as SignInLike);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-full max-w-sm items-center px-4">
      <Card className="w-full" title="sakekasu 家計簿">
        <form onSubmit={submit} className="space-y-3">
          {phase === 'signed-out' && (
            <>
              <Field label="ユーザー名">
                <Input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" autoFocus />
              </Field>
              <Field label="パスワード">
                <Input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                />
              </Field>
            </>
          )}

          {phase === 'new-password' && (
            <Field label="新しいパスワード" hint="初回サインインでは設定が必要です">
              <Input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="new-password"
                autoFocus
              />
            </Field>
          )}

          {phase === 'totp-setup' && setup && (
            <div className="space-y-3">
              <p className="text-sm text-ink-2">
                認証アプリを登録します。QR を読み取るか、下の鍵を手で入れてください。
              </p>

              {qr ? (
                <img src={qr} alt="認証アプリ登録用の QR コード" className="mx-auto rounded bg-white p-2" width={220} height={220} />
              ) : (
                <p className="text-xs text-ink-2">QR を出せませんでした。下の鍵を使ってください。</p>
              )}

              <Field label="鍵（手で入れる場合）" hint="読み取れないときはこれをコピーします">
                <Input value={setup.sharedSecret} readOnly onFocus={(event) => event.target.select()} />
              </Field>

              <p className="text-xs text-ink-2">
                <a className="text-accent underline" href={setup.getSetupUri(ISSUER, username || undefined).toString()}>
                  認証アプリで開く
                </a>
                （スマートフォンならこちらが早いです）
              </p>

              <Field label="認証アプリに出た 6 桁" hint="登録はこのコードを入れて完了します">
                <Input value={code} onChange={(event) => setCode(event.target.value)} inputMode="numeric" autoFocus />
              </Field>
            </div>
          )}

          {phase === 'totp' && (
            <Field label="認証アプリのコード">
              <Input value={code} onChange={(event) => setCode(event.target.value)} inputMode="numeric" autoFocus />
            </Field>
          )}

          {error && <p className="text-xs text-critical">{error}</p>}

          <Button type="submit" variant="primary" className="w-full" disabled={busy}>
            {busy ? '処理中…' : phase === 'signed-out' ? 'サインイン' : '決定'}
          </Button>
        </form>
      </Card>
    </div>
  );
}
