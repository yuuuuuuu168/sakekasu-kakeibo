import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

/*
 * MFA を必須にしたので、登録していないユーザーはサインインの途中で登録の段に入る。
 * その段を画面が扱えないとサインインする手段が無くなるため、段の遷移をここで見張る。
 *
 * QR の生成は動的 import。jsdom では canvas が無く落ちるので、鍵の併記だけで
 * 行き止まりにならないことも見る。
 */

const signIn = vi.fn();
const confirmSignIn = vi.fn();
const getCurrentUser = vi.fn();
const signOut = vi.fn();

vi.mock('aws-amplify/auth', () => ({
  signIn: (...args: unknown[]) => signIn(...args),
  confirmSignIn: (...args: unknown[]) => confirmSignIn(...args),
  getCurrentUser: (...args: unknown[]) => getCurrentUser(...args),
  signOut: (...args: unknown[]) => signOut(...args),
}));

vi.mock('../../../config', () => ({ config: { mode: 'remote', apiUrl: 'https://example.test' } }));

const { AuthGate } = await import('../AuthGate');

const totpSetupDetails = {
  sharedSecret: 'JBSWY3DPEHPK3PXP',
  getSetupUri: () => new URL('otpauth://totp/sakekasu-kakeibo:me?secret=JBSWY3DPEHPK3PXP'),
};

function renderGate() {
  return render(<AuthGate>{() => <p>ダッシュボード</p>}</AuthGate>);
}

/** サインインの画面が出るまで待つ（初回に現在のユーザーを見にいくため） */
async function signInAs(name: string, pass: string) {
  renderGate();
  const nameInput = await screen.findByLabelText('ユーザー名');
  fireEvent.change(nameInput, { target: { value: name } });
  fireEvent.change(screen.getByLabelText('パスワード'), { target: { value: pass } });
  fireEvent.click(screen.getByRole('button', { name: 'サインイン' }));
}

/*
 * 値を入れて「決定」を押す。
 *
 * Field は hint も label の中に入れるので、入力の読み上げ名が「ラベル＋補足」になる。
 * 前方一致で引く。
 */
function answer(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(new RegExp(`^${label}`)), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: '決定' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  getCurrentUser.mockRejectedValue(new Error('未サインイン'));
});

describe('AuthGate', () => {
  it('登録済みならコードを入れて入れる', async () => {
    signIn.mockResolvedValue({ isSignedIn: false, nextStep: { signInStep: 'CONFIRM_SIGN_IN_WITH_TOTP_CODE' } });
    confirmSignIn.mockResolvedValue({ isSignedIn: true, nextStep: { signInStep: 'DONE' } });

    await signInAs('me', 'Password1234');

    await screen.findByLabelText('認証アプリのコード');
    answer('認証アプリのコード', '123456');

    await waitFor(() => expect(screen.getByText('ダッシュボード')).toBeInTheDocument());
    expect(confirmSignIn).toHaveBeenCalledWith({ challengeResponse: '123456' });
  });

  it('未登録なら鍵を見せて、コードで登録を完了できる', async () => {
    signIn.mockResolvedValue({
      isSignedIn: false,
      nextStep: { signInStep: 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP', totpSetupDetails },
    });
    confirmSignIn.mockResolvedValue({ isSignedIn: true, nextStep: { signInStep: 'DONE' } });

    await signInAs('me', 'Password1234');

    // QR が出せない環境でも、鍵が見えていれば手で登録できる
    expect(await screen.findByDisplayValue('JBSWY3DPEHPK3PXP')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '認証アプリで開く' })).toHaveAttribute(
      'href',
      'otpauth://totp/sakekasu-kakeibo:me?secret=JBSWY3DPEHPK3PXP',
    );

    answer('認証アプリに出た 6 桁', '654321');

    await waitFor(() => expect(screen.getByText('ダッシュボード')).toBeInTheDocument());
    expect(confirmSignIn).toHaveBeenCalledWith({ challengeResponse: '654321' });
  });

  /*
   * 手で作ったユーザーの初回はこの順になる。パスワードを変えた直後に登録の段が来るので、
   * 応答を 1 回しか見ない作りだとここで止まる。
   */
  it('パスワード変更のあとに登録の段が来ても続けられる', async () => {
    signIn.mockResolvedValue({
      isSignedIn: false,
      nextStep: { signInStep: 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED' },
    });
    confirmSignIn
      .mockResolvedValueOnce({
        isSignedIn: false,
        nextStep: { signInStep: 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP', totpSetupDetails },
      })
      .mockResolvedValueOnce({ isSignedIn: true, nextStep: { signInStep: 'DONE' } });

    await signInAs('me', 'Temp12345678');

    await screen.findByLabelText(/^新しいパスワード/);
    answer('新しいパスワード', 'Password1234');

    expect(await screen.findByDisplayValue('JBSWY3DPEHPK3PXP')).toBeInTheDocument();

    answer('認証アプリに出た 6 桁', '111222');

    await waitFor(() => expect(screen.getByText('ダッシュボード')).toBeInTheDocument());
  });

  /* 認証アプリしか有効にしていないので、選ばせる画面を出す意味が無い */
  it('二要素の選択を求められたら認証アプリで自動的に答える', async () => {
    signIn.mockResolvedValue({
      isSignedIn: false,
      nextStep: { signInStep: 'CONTINUE_SIGN_IN_WITH_MFA_SELECTION', allowedMFATypes: ['TOTP'] },
    });
    confirmSignIn.mockResolvedValue({ isSignedIn: false, nextStep: { signInStep: 'CONFIRM_SIGN_IN_WITH_TOTP_CODE' } });

    await signInAs('me', 'Password1234');

    await waitFor(() => expect(confirmSignIn).toHaveBeenCalledWith({ challengeResponse: 'TOTP' }));
    expect(await screen.findByLabelText('認証アプリのコード')).toBeInTheDocument();
  });

  it('知らない段が来たら何が来たかを画面に出す', async () => {
    signIn.mockResolvedValue({ isSignedIn: false, nextStep: { signInStep: 'CONFIRM_SIGN_IN_WITH_SMS_CODE' } });

    await signInAs('me', 'Password1234');

    expect(await screen.findByText(/CONFIRM_SIGN_IN_WITH_SMS_CODE/)).toBeInTheDocument();
  });

  it('サインイン済みならそのまま中身を出す', async () => {
    getCurrentUser.mockResolvedValue({ username: 'me' });
    renderGate();
    await waitFor(() => expect(screen.getByText('ダッシュボード')).toBeInTheDocument());
    expect(signIn).not.toHaveBeenCalled();
  });
});
