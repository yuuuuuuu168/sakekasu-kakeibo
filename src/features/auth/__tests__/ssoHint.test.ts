import { describe, expect, it } from 'vitest';
import { isOAuthCallback, readSsoHint } from '../ssoHint';

const at = (pathname: string, search = '', hash = '') => ({ pathname, search, hash });

describe('readSsoHint', () => {
  it('sso=1 を読み、パス・ほかのクエリ・ハッシュを残して消す', () => {
    expect(readSsoHint(at('/', '?a=1&sso=1&b=2', '#/receipts'))).toEqual({
      hint: true,
      cleaned: '/?a=1&b=2#/receipts',
    });
  });

  it('sso だけならクエリごと消す', () => {
    expect(readSsoHint(at('/', '?sso=1'))).toEqual({ hint: true, cleaned: '/' });
  });

  it('合図が無ければ何もしない', () => {
    expect(readSsoHint(at('/', '?a=1', '#/x'))).toEqual({ hint: false, cleaned: undefined });
    expect(readSsoHint(at('/'))).toEqual({ hint: false, cleaned: undefined });
  });

  it('1 以外の値は合図として扱わないが、URL からは消す', () => {
    expect(readSsoHint(at('/', '?sso=0&a=1'))).toEqual({ hint: false, cleaned: '/?a=1' });
  });
});

describe('isOAuthCallback', () => {
  it('code か error があれば戻りとみなす', () => {
    expect(isOAuthCallback('?code=abc&state=s')).toBe(true);
    expect(isOAuthCallback('?error=access_denied')).toBe(true);
    expect(isOAuthCallback('?sso=1')).toBe(false);
    expect(isOAuthCallback('')).toBe(false);
  });
});
