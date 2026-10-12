import { describe, expect, it } from 'vitest';
import { PORTAL_URL, signOutRedirect } from '../signOutRedirect';

const at = (origin: string) => ({ origin, hostname: new URL(origin).hostname });

/*
 * 本番のサインアウトはポータルのトップで終わらせ、手元は自分のルートへ戻す。
 * Amplify は redirectUrl が redirectSignOut に完全一致で含まれていないと投げるので、一覧と選択をそろえて見る。
 */
describe('signOutRedirect', () => {
  it('ポータルの URL は共通ログインに登録したものと末尾の / まで同じ', () => {
    expect(PORTAL_URL).toBe('https://sakekasu-builder.com/');
  });

  it('本番ではポータルのトップを選び、一覧にも入れる', () => {
    const result = signOutRedirect(at('https://kakeibo.sakekasu-builder.com'));
    expect(result.preferred).toBe(PORTAL_URL);
    expect(result.allowed).toEqual(['https://kakeibo.sakekasu-builder.com/', PORTAL_URL]);
    expect(result.allowed).toContain(result.preferred);
  });

  it('CloudFront の既定ドメインで配っていてもポータルへ帰す', () => {
    expect(signOutRedirect(at('https://d111111abcdef8.cloudfront.net')).preferred).toBe(PORTAL_URL);
  });

  it('localhost では選ばず、自分のルートだけを並べる', () => {
    expect(signOutRedirect(at('http://localhost:5173'))).toEqual({
      allowed: ['http://localhost:5173/'],
      preferred: undefined,
    });
  });

  it('127.0.0.1 も手元として扱う', () => {
    expect(signOutRedirect(at('http://127.0.0.1:5173'))).toEqual({
      allowed: ['http://127.0.0.1:5173/'],
      preferred: undefined,
    });
  });
});
