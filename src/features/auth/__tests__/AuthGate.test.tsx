import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

/*
 * ログインは共通のマネージドログインへリダイレクトして行う。この画面が受け持つのは
 * 「送り出す」「戻ってきたら中身を出す」「失敗を見せる」の 3 つだけなので、そこを見張る。
 * 未サインインなら 1 回だけ自動で送り出すので、表紙（ボタンの画面）を見るテストは
 * 先に sessionStorage へ「もう送った」印を入れておく（alreadyAutoSent）。
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
  PORTAL_URL: 'https://sakekasu-builder.com/',
  signOutRedirect: () => ({ allowed: [], preferred: mockRedirect.preferred }),
}));

const { AuthGate } = await import('../AuthGate');
const { AUTO_SIGN_IN_KEY } = await import('../autoSignIn');

const SIGN_IN = 'パスキーでログイン';

/** このタブで自動の送り出しを使い終えた状態にする（戻ってきてもまだ未サインイン、のとき） */
const alreadyAutoSent = () => window.sessionStorage.setItem(AUTO_SIGN_IN_KEY, '1');

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
  window.sessionStorage.clear();
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

  it('ボタンでマネージドログインへ送る', async () => {
    alreadyAutoSent();
    renderGate();
    fireEvent.click(await screen.findByRole('button', { name: SIGN_IN }));
    await waitFor(() => expect(signInWithRedirect).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('ダッシュボード')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: SIGN_IN })).toBeDisabled();
  });

  /* 表紙はポータルのトップと同じ並び。入口へ戻るリンクはポータルのトップを指す */
  it('表紙にアプリ名・一言・入口へのリンクを出す', async () => {
    alreadyAutoSent();
    renderGate();
    expect(await screen.findByRole('heading', { name: '家計簿' })).toBeInTheDocument();
    expect(screen.getByText('レシートと明細の家計簿')).toBeInTheDocument();
    expect(screen.getByText('共通ログインの画面へ移動します')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '← sakekasu の入口へ' })).toHaveAttribute('href', PORTAL);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  /* ユーザー名もパスワードも MFA もこの画面では聞かない（マネージドログインの仕事） */
  it('独自の入力欄を出さない', async () => {
    alreadyAutoSent();
    renderGate();
    await screen.findByRole('button', { name: SIGN_IN });
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(document.querySelector('input')).toBeNull();
  });

  it('戻ってきてトークンに換え終わったら中身を出し、印を消す', async () => {
    alreadyAutoSent();
    renderGate();
    await screen.findByRole('button', { name: SIGN_IN });

    getCurrentUser.mockResolvedValue({ username: 'me', userId: 'sub' });
    emit('signInWithRedirect');

    expect(await screen.findByText('ダッシュボード')).toBeInTheDocument();
    expect(window.sessionStorage.getItem(AUTO_SIGN_IN_KEY)).toBeNull();
  });

  it('戻ってきて失敗したら理由を出し、もう一度送り出せる', async () => {
    alreadyAutoSent();
    renderGate();
    await screen.findByRole('button', { name: SIGN_IN });

    emit('signInWithRedirect_failure', { error: new Error('invalid_grant') });

    expect(await screen.findByRole('alert')).toHaveTextContent('ログインできませんでした。もう一度お試しください。');
    expect(screen.getByText(/invalid_grant/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: SIGN_IN }));
    await waitFor(() => expect(signInWithRedirect).toHaveBeenCalledTimes(1));
  });

  it('送り出しに失敗したら理由を出してボタンに戻す', async () => {
    alreadyAutoSent();
    signInWithRedirect.mockRejectedValue(new Error('OAuth の設定がありません'));
    renderGate();
    fireEvent.click(await screen.findByRole('button', { name: SIGN_IN }));
    expect(await screen.findByText(/OAuth の設定がありません/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: SIGN_IN })).toBeEnabled();
  });

  it('既にサインイン済みと言われたら中身を出す', async () => {
    alreadyAutoSent();
    const error = Object.assign(new Error('already'), { name: 'UserAlreadyAuthenticatedException' });
    signInWithRedirect.mockRejectedValue(error);
    renderGate();
    fireEvent.click(await screen.findByRole('button', { name: SIGN_IN }));
    expect(await screen.findByText('ダッシュボード')).toBeInTheDocument();
  });

  it('サインアウトで signOut を呼び、表紙に戻る', async () => {
    getCurrentUser.mockResolvedValue({ username: 'me', userId: 'sub' });
    renderGate();
    fireEvent.click(await screen.findByRole('button', { name: 'サインアウト' }));
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('button', { name: SIGN_IN })).toBeInTheDocument();
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
    alreadyAutoSent();
    const { unmount } = renderGate();
    await screen.findByRole('button', { name: SIGN_IN });
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });

  /* ローカルモードは Cognito を一切呼ばずに中身を出す */
  it('ローカルモードでは何も呼ばずに中身を出す', async () => {
    mockConfig.config.mode = 'local';
    renderGate();
    expect(screen.getByText('ダッシュボード')).toBeInTheDocument();
    expect(getCurrentUser).not.toHaveBeenCalled();
    expect(signInWithRedirect).not.toHaveBeenCalled();
    expect(listeners).toHaveLength(0);
    expect(window.sessionStorage.getItem(AUTO_SIGN_IN_KEY)).toBeNull();
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
   * 未サインインなら、ボタンを押させずに 1 回だけ自動で送り出す。印を置いてから送り、
   * 印があれば（戻ってきてもまだ未サインイン）表紙を出す。戻りの最中も送り出さない
   */
  describe('自動の送り出し', () => {
    it('未サインインなら印を置いて 1 回だけ自動で送り出し、その間は確認中のまま', async () => {
      renderGate();
      await waitFor(() => expect(signInWithRedirect).toHaveBeenCalledTimes(1));
      expect(window.sessionStorage.getItem(AUTO_SIGN_IN_KEY)).not.toBeNull();
      expect(screen.getByText('確認中…')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: SIGN_IN })).not.toBeInTheDocument();
      await act(async () => {});
      expect(signInWithRedirect).toHaveBeenCalledTimes(1);
    });

    it('印があれば（2 回目）自動では送らずに表紙を出す', async () => {
      alreadyAutoSent();
      renderGate();
      expect(await screen.findByRole('button', { name: SIGN_IN })).toBeEnabled();
      expect(signInWithRedirect).not.toHaveBeenCalled();
    });

    it('1 回目で戻ってきてまだ未サインインなら、2 回目の表示では表紙を出す', async () => {
      const first = renderGate();
      await waitFor(() => expect(signInWithRedirect).toHaveBeenCalledTimes(1));
      first.unmount();

      // マネージドログインで戻る・取り消すと、印を残したまま素のルートへ帰ってくる
      renderGate();
      expect(await screen.findByRole('button', { name: SIGN_IN })).toBeInTheDocument();
      expect(signInWithRedirect).toHaveBeenCalledTimes(1);
    });

    /* ボタンは印に関係なく必ず進む */
    it('印があってもボタンは送り出す', async () => {
      alreadyAutoSent();
      renderGate();
      fireEvent.click(await screen.findByRole('button', { name: SIGN_IN }));
      await waitFor(() => expect(signInWithRedirect).toHaveBeenCalledTimes(1));
    });

    it('サインイン済みなら送り出さず、残っていた印を消す', async () => {
      alreadyAutoSent();
      getCurrentUser.mockResolvedValue({ username: 'me', userId: 'sub' });
      renderGate();
      expect(await screen.findByText('ダッシュボード')).toBeInTheDocument();
      expect(signInWithRedirect).not.toHaveBeenCalled();
      expect(window.sessionStorage.getItem(AUTO_SIGN_IN_KEY)).toBeNull();
    });

    it('戻りの最中（?code）なら自動では送り出さない', async () => {
      window.history.replaceState(null, '', '/?code=abc&state=s');
      renderGate();
      await screen.findByRole('button', { name: SIGN_IN });
      expect(signInWithRedirect).not.toHaveBeenCalled();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('?error= 付きで戻ったら自動では送り出さず、エラー文を出す', async () => {
      window.history.replaceState(null, '', '/?error=access_denied');
      renderGate();
      expect(await screen.findByRole('alert')).toHaveTextContent('ログインできませんでした。もう一度お試しください。');
      expect(screen.getByRole('button', { name: SIGN_IN })).toBeEnabled();
      expect(signInWithRedirect).not.toHaveBeenCalled();
    });

    it('戻りの失敗が先に届いたら自動では送り出さず理由を出す', async () => {
      let reject: (cause: unknown) => void = () => {};
      getCurrentUser.mockReturnValue(new Promise((_, r) => (reject = r)));
      renderGate();
      emit('signInWithRedirect_failure', { error: new Error('invalid_grant') });
      await act(async () => reject(new Error('未サインイン')));
      expect(await screen.findByText(/invalid_grant/)).toBeInTheDocument();
      expect(signInWithRedirect).not.toHaveBeenCalled();
    });

    it('自動の送り出しで既にサインイン済みと言われたら中身を出す', async () => {
      const error = Object.assign(new Error('already'), { name: 'UserAlreadyAuthenticatedException' });
      signInWithRedirect.mockRejectedValue(error);
      renderGate();
      expect(await screen.findByText('ダッシュボード')).toBeInTheDocument();
      expect(window.sessionStorage.getItem(AUTO_SIGN_IN_KEY)).toBeNull();
    });

    it('自動の送り出しに失敗したら表紙に理由を出す', async () => {
      signInWithRedirect.mockRejectedValue(new Error('OAuth の設定がありません'));
      renderGate();
      expect(await screen.findByText(/OAuth の設定がありません/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: SIGN_IN })).toBeEnabled();
    });

    /* ポータルが付けてくる ?sso=1 は、もう意味が無いが URL には残さない */
    it('?sso=1 は URL から消し、付いていなくても同じく送り出す', async () => {
      window.history.replaceState(null, '', '/?sso=1&from=portal#/receipts');
      renderGate();
      expect(currentUrl()).toBe('/?from=portal#/receipts');
      await waitFor(() => expect(signInWithRedirect).toHaveBeenCalledTimes(1));
    });

    it('ローカルモードでは何も呼ばず、URL も印も触らない', async () => {
      mockConfig.config.mode = 'local';
      window.history.replaceState(null, '', '/?sso=1');
      renderGate();
      expect(screen.getByText('ダッシュボード')).toBeInTheDocument();
      expect(getCurrentUser).not.toHaveBeenCalled();
      expect(signInWithRedirect).not.toHaveBeenCalled();
      expect(currentUrl()).toBe('/?sso=1');
      expect(window.sessionStorage.getItem(AUTO_SIGN_IN_KEY)).toBeNull();
    });
  });
});
