import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { confirmSignIn, getCurrentUser, signIn, signOut } from 'aws-amplify/auth';
import { Button, Card, Field, Input } from '../../components/ui/primitives';
import { config } from '../../config';

type Phase = 'checking' | 'signed-out' | 'new-password' | 'totp' | 'signed-in';

/**
 * 利用者は本人ひとりで、Cognito のユーザーは手で 1 つ作る前提。サインアップの画面は無い。
 * 初回サインインは必ず新しいパスワードの設定を求められるので、そこだけは面倒を見る。
 */
export function AuthGate({ children }: { children: (signOutFn: () => Promise<void>) => ReactNode }) {
  const [phase, setPhase] = useState<Phase>(config.mode === 'remote' ? 'checking' : 'signed-in');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (config.mode !== 'remote') return;
    getCurrentUser()
      .then(() => setPhase('signed-in'))
      .catch(() => setPhase('signed-out'));
  }, []);

  const handleSignOut = useCallback(async () => {
    if (config.mode !== 'remote') return;
    await signOut();
    setPhase('signed-out');
  }, []);

  if (phase === 'signed-in') return <>{children(handleSignOut)}</>;
  if (phase === 'checking') {
    return <p className="p-8 text-center text-sm text-ink-2">確認中…</p>;
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      if (phase === 'signed-out') {
        const result = await signIn({ username, password });
        const step = result.nextStep.signInStep;
        if (result.isSignedIn) setPhase('signed-in');
        else if (step === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED') setPhase('new-password');
        else if (step === 'CONFIRM_SIGN_IN_WITH_TOTP_CODE') setPhase('totp');
        else setError(`この認証方法にはまだ対応していません: ${step}`);
        return;
      }

      const answer = phase === 'new-password' ? password : code;
      const result = await confirmSignIn({ challengeResponse: answer });
      if (result.isSignedIn) setPhase('signed-in');
      else setError(`続きの手順が必要です: ${result.nextStep.signInStep}`);
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
