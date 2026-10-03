import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

/*
 * ログインは共通のマネージドログインへリダイレクトして行う。この画面が受け持つのは
 * 「送り出す」「戻ってきたら中身を出す」「失敗を見せる」の 3 つだけなので、そこを見張る。
 */

const signInWithRedirect = vi.fn();
const getCurrentUser = vi.fn();
const signOut = vi.fn();

vi.mock('aws-amplify/auth', () => ({
  signInWithRedirect: (...args: unknown[]) => signInWithRedirect(...args),
  getCurrentUser: (...args: unknown[]) => getCurrentUser(...args),
  signOut: (...args: unknown[]) => signOut(...args),
}));

/* Hub の auth チャンネルはアプリから流せないので、聞き手を捕まえて手で流す */
type HubCallback = (capsule: { payload: { event: string; data?: { error?: unknown } } }) => void;
const listeners: HubCallback[] = [];
const unsubscribe = vi.fn();
vi.mock('aws-amplify/utils', () => ({
  Hub: {
    listen: (_channel: string, callback: HubCallback) => {
      listeners.push(callback);
      return unsubscribe;
    },
  },
}));

function emit(event: string, data?: { error?: unknown }) {
  act(() => {
    for (const listener of listeners) listener({ payload: { event, data } });
  });
}

const mockConfig = vi.hoisted(() => ({ config: { mode: 'remote' as 'remote' | 'local', apiUrl: 'https://example.test' } }));
vi.mock('../../../config', () => mockConfig);

const { AuthGate } = await import('../AuthGate');

function renderGate() {
  return render(
    <AuthGate>
      {(signOutFn) => (
        <div>
          <p>ダッシュボード</p>
          <button onClick={() => void signOutFn()}>サインアウト</button>
        </div>
      )}
    </AuthGate>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  listeners.length = 0;
  mockConfig.config.mode = 'remote';
  getCurrentUser.mockRejectedValue(new Error('未サインイン'));
  signInWithRedirect.mockResolvedValue(undefined);
  signOut.mockResolvedValue(undefined);
});

describe('AuthGate', () => {
  it('サインイン済みならそのまま中身を出す', async () => {
    getCurrentUser.mockResolvedValue({ username: 'me', userId: 'sub' });
    renderGate();
    expect(await screen.findByText('ダッシュボード')).toBeInTheDocument();
    expect(signInWithRedirect).not.toHaveBeenCalled();
  });

  it('未サインインならボタンでマネージドログインへ送る', async () => {
    renderGate();
    fireEvent.click(await screen.findByRole('button', { name: 'ログイン画面へ' }));
    await waitFor(() => expect(signInWithRedirect).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('ダッシュボード')).not.toBeInTheDocument();
  });

  /* ユーザー名もパスワードも MFA もこの画面では聞かない（マネージドログインの仕事） */
  it('独自の入力欄を出さない', async () => {
    renderGate();
    await screen.findByRole('button', { name: 'ログイン画面へ' });
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(document.querySelector('input')).toBeNull();
  });

  it('戻ってきてトークンに換え終わったら中身を出す', async () => {
    renderGate();
    await screen.findByRole('button', { name: 'ログイン画面へ' });

    getCurrentUser.mockResolvedValue({ username: 'me', userId: 'sub' });
    emit('signInWithRedirect');

    expect(await screen.findByText('ダッシュボード')).toBeInTheDocument();
  });

  it('戻ってきて失敗したら理由を出し、もう一度送り出せる', async () => {
    renderGate();
    await screen.findByRole('button', { name: 'ログイン画面へ' });

    emit('signInWithRedirect_failure', { error: new Error('invalid_grant') });

    expect(await screen.findByText(/invalid_grant/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'ログイン画面へ' }));
    await waitFor(() => expect(signInWithRedirect).toHaveBeenCalledTimes(1));
  });

  it('送り出しに失敗したら理由を出してボタンに戻す', async () => {
    signInWithRedirect.mockRejectedValue(new Error('OAuth の設定がありません'));
    renderGate();
    fireEvent.click(await screen.findByRole('button', { name: 'ログイン画面へ' }));
    expect(await screen.findByText(/OAuth の設定がありません/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ログイン画面へ' })).toBeEnabled();
  });

  it('既にサインイン済みと言われたら中身を出す', async () => {
    const error = Object.assign(new Error('already'), { name: 'UserAlreadyAuthenticatedException' });
    signInWithRedirect.mockRejectedValue(error);
    renderGate();
    fireEvent.click(await screen.findByRole('button', { name: 'ログイン画面へ' }));
    expect(await screen.findByText('ダッシュボード')).toBeInTheDocument();
  });

  it('サインアウトで signOut を呼び、ボタンの画面に戻る', async () => {
    getCurrentUser.mockResolvedValue({ username: 'me', userId: 'sub' });
    renderGate();
    fireEvent.click(await screen.findByRole('button', { name: 'サインアウト' }));
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('button', { name: 'ログイン画面へ' })).toBeInTheDocument();
  });

  /* ログイン中のユーザー名・メールは出さない（要望） */
  it('ユーザー名を画面に出さない', async () => {
    getCurrentUser.mockResolvedValue({ username: 'someone@example.com', userId: 'sub' });
    renderGate();
    await screen.findByText('ダッシュボード');
    expect(screen.queryByText(/someone@example.com/)).not.toBeInTheDocument();
  });

  it('画面を閉じたら Hub の購読を外す', async () => {
    const { unmount } = renderGate();
    await screen.findByRole('button', { name: 'ログイン画面へ' });
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });

  /* ローカルモードは Cognito を一切呼ばずに中身を出す */
  it('ローカルモードでは何も呼ばずに中身を出す', async () => {
    mockConfig.config.mode = 'local';
    renderGate();
    expect(screen.getByText('ダッシュボード')).toBeInTheDocument();
    expect(getCurrentUser).not.toHaveBeenCalled();
    expect(listeners).toHaveLength(0);
  });
});
