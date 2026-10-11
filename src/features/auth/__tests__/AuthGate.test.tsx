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

/* jsdom の location は差し替えにくいので、戻り先の判定だけ差し替えて本番と手元を作る（判定そのものは signOutRedirect.test.ts） */
const PORTAL = 'https://sakekasu-builder.com/';
const mockRedirect = vi.hoisted(() => ({ preferred: undefined as string | undefined }));
vi.mock('../signOutRedirect', () => ({
  signOutRedirect: () => ({ allowed: [], preferred: mockRedirect.preferred }),
}));

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
  mockRedirect.preferred = undefined;
  getCurrentUser.mockRejectedValue(new Error('未サインイン'));
  signInWithRedirect.mockResolvedValue(undefined);
  signOut.mockResolvedValue(undefined);
  window.history.replaceState(null, '', '/');
});

/** 今の URL（パス・クエリ・ハッシュ） */
const currentUrl = () => `${window.location.pathname}${window.location.search}${window.location.hash}`;

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

  /* 本番はポータルのトップへ帰す。手元（localhost）は戻り先を指定せず、Amplify に自分のルートを選ばせる */
  it('本番ではサインアウトの戻り先にポータルのトップを指定する', async () => {
    mockRedirect.preferred = PORTAL;
    getCurrentUser.mockResolvedValue({ username: 'me', userId: 'sub' });
    renderGate();
    fireEvent.click(await screen.findByRole('button', { name: 'サインアウト' }));
    await waitFor(() =>
      expect(signOut).toHaveBeenCalledWith({ global: false, oauth: { redirectUrl: PORTAL } }),
    );
  });

  it('手元では戻り先を指定せずに signOut を呼ぶ', async () => {
    getCurrentUser.mockResolvedValue({ username: 'me', userId: 'sub' });
    renderGate();
    fireEvent.click(await screen.findByRole('button', { name: 'サインアウト' }));
    await waitFor(() => expect(signOut).toHaveBeenCalledWith(undefined));
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

  it('ローカルモードではサインアウトしても signOut を呼ばない', async () => {
    mockConfig.config.mode = 'local';
    mockRedirect.preferred = PORTAL;
    renderGate();
    fireEvent.click(screen.getByRole('button', { name: 'サインアウト' }));
    await act(async () => {});
    expect(signOut).not.toHaveBeenCalled();
    expect(screen.getByText('ダッシュボード')).toBeInTheDocument();
  });

  /*
   * ポータルから ?sso=1 で来たときだけ、ボタンを押させずに送り出す。合図はすぐ URL から消し、
   * 戻りの最中やサインイン済みのときは送り出さない（送り出しと失敗の輪に入らないため）
   */
  describe('ポータルからの合図（?sso=1）', () => {
    it('未サインインなら 1 回だけ自動で送り出し、URL から合図を消す', async () => {
      window.history.replaceState(null, '', '/?sso=1&from=portal#/receipts');
      renderGate();
      expect(currentUrl()).toBe('/?from=portal#/receipts');
      await waitFor(() => expect(signInWithRedirect).toHaveBeenCalledTimes(1));
      expect(await screen.findByRole('button', { name: 'ログイン画面へ移動中…' })).toBeDisabled();
      expect(signInWithRedirect).toHaveBeenCalledTimes(1);
    });

    it('合図が無ければ自動では送り出さない', async () => {
      renderGate();
      await screen.findByRole('button', { name: 'ログイン画面へ' });
      expect(signInWithRedirect).not.toHaveBeenCalled();
    });

    it('サインイン済みなら送り出さず、URL から合図は消す', async () => {
      getCurrentUser.mockResolvedValue({ username: 'me', userId: 'sub' });
      window.history.replaceState(null, '', '/?sso=1');
      renderGate();
      expect(await screen.findByText('ダッシュボード')).toBeInTheDocument();
      expect(currentUrl()).toBe('/');
      expect(signInWithRedirect).not.toHaveBeenCalled();
    });

    it('戻りの最中（?code）なら自動では送り出さない', async () => {
      window.history.replaceState(null, '', '/?sso=1&code=abc&state=s');
      renderGate();
      await screen.findByRole('button', { name: 'ログイン画面へ' });
      expect(currentUrl()).toBe('/?code=abc&state=s');
      expect(signInWithRedirect).not.toHaveBeenCalled();
    });

    it('戻りの失敗（?error）なら自動では送り出さない', async () => {
      window.history.replaceState(null, '', '/?sso=1&error=access_denied');
      renderGate();
      await screen.findByRole('button', { name: 'ログイン画面へ' });
      expect(signInWithRedirect).not.toHaveBeenCalled();
    });

    it('戻りの失敗が先に届いたら自動では送り出さず理由を出す', async () => {
      let reject: (cause: unknown) => void = () => {};
      getCurrentUser.mockReturnValue(new Promise((_, r) => (reject = r)));
      window.history.replaceState(null, '', '/?sso=1');
      renderGate();
      emit('signInWithRedirect_failure', { error: new Error('invalid_grant') });
      await act(async () => reject(new Error('未サインイン')));
      expect(await screen.findByText(/invalid_grant/)).toBeInTheDocument();
      expect(signInWithRedirect).not.toHaveBeenCalled();
    });

    it('自動の送り出しで既にサインイン済みと言われたら中身を出す', async () => {
      const error = Object.assign(new Error('already'), { name: 'UserAlreadyAuthenticatedException' });
      signInWithRedirect.mockRejectedValue(error);
      window.history.replaceState(null, '', '/?sso=1');
      renderGate();
      expect(await screen.findByText('ダッシュボード')).toBeInTheDocument();
    });

    it('ローカルモードでは合図があっても何も呼ばず、URL も触らない', async () => {
      mockConfig.config.mode = 'local';
      window.history.replaceState(null, '', '/?sso=1');
      renderGate();
      expect(screen.getByText('ダッシュボード')).toBeInTheDocument();
      expect(getCurrentUser).not.toHaveBeenCalled();
      expect(signInWithRedirect).not.toHaveBeenCalled();
      expect(currentUrl()).toBe('/?sso=1');
    });
  });
});
