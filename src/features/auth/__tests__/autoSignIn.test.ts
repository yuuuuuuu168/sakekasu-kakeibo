import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUTO_SIGN_IN_KEY,
  clearAutoSignIn,
  hasAutoSignedIn,
  isOAuthCallback,
  isOAuthError,
  markAutoSignIn,
  stripSsoHint,
} from '../autoSignIn';

const at = (pathname: string, search = '', hash = '') => ({ pathname, search, hash });

afterEach(() => {
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});

describe('自動の送り出しの印', () => {
  it('置く前は無く、置くとあり、消すとまた無い', () => {
    expect(hasAutoSignedIn()).toBe(false);
    markAutoSignIn();
    expect(window.sessionStorage.getItem(AUTO_SIGN_IN_KEY)).not.toBeNull();
    expect(hasAutoSignedIn()).toBe(true);
    clearAutoSignIn();
    expect(hasAutoSignedIn()).toBe(false);
  });

  /* 輪に入るより、ボタンを押させる方がよい */
  it('sessionStorage が読めないときは「もう送った」とみなす', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(hasAutoSignedIn()).toBe(true);
  });

  it('書けない・消せないときも投げない', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(() => markAutoSignIn()).not.toThrow();
    expect(() => clearAutoSignIn()).not.toThrow();
  });
});

describe('stripSsoHint', () => {
  it('sso を消し、パス・ほかのクエリ・ハッシュを残す', () => {
    expect(stripSsoHint(at('/', '?a=1&sso=1&b=2', '#/receipts'))).toBe('/?a=1&b=2#/receipts');
  });

  it('sso だけならクエリごと消す', () => {
    expect(stripSsoHint(at('/', '?sso=1'))).toBe('/');
  });

  it('合図が無ければ何もしない', () => {
    expect(stripSsoHint(at('/', '?a=1', '#/x'))).toBeUndefined();
    expect(stripSsoHint(at('/'))).toBeUndefined();
  });

  it('1 以外の値も一緒に消す', () => {
    expect(stripSsoHint(at('/', '?sso=0&a=1'))).toBe('/?a=1');
  });
});

describe('isOAuthCallback / isOAuthError', () => {
  it('code か error があれば戻りとみなす', () => {
    expect(isOAuthCallback('?code=abc&state=s')).toBe(true);
    expect(isOAuthCallback('?error=access_denied')).toBe(true);
    expect(isOAuthCallback('?sso=1')).toBe(false);
    expect(isOAuthCallback('')).toBe(false);
  });

  it('error があるときだけ失敗の戻りとみなす', () => {
    expect(isOAuthError('?error=access_denied&error_description=x')).toBe(true);
    expect(isOAuthError('?code=abc&state=s')).toBe(false);
    expect(isOAuthError('')).toBe(false);
  });
});
