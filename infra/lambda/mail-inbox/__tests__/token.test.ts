import { describe, expect, it } from 'vitest';
import { daysLeft, hashToken, parseKeys, verifyBearer, type InboxKey } from '../token';

const now = new Date('2026-11-22T12:00:00Z');
const token = 'kkb_test-token-0123456789abcdefghijklmnopqrstu';
const key: InboxKey = { id: 'muse-20261122-ab12', tokenHash: hashToken(token), sub: 'sub-1', expiresAt: '2027-02-20T12:00:00Z' };
const other: InboxKey = { ...key, id: 'muse-old', tokenHash: hashToken('kkb_other') };

describe('verifyBearer', () => {
  it('一致するトークンの鍵を返す（並んだ鍵のどれでも）', () => {
    expect(verifyBearer(`Bearer ${token}`, [other, key], now)).toEqual({ ok: true, key });
    expect(verifyBearer(`bearer  ${token}`, [key], now).ok).toBe(true);
  });

  it('違うトークン・ヘッダの欠け・Bearer でない形は弾く', () => {
    expect(verifyBearer(`Bearer ${token}x`, [key], now)).toMatchObject({ ok: false });
    expect(verifyBearer(undefined, [key], now)).toMatchObject({ ok: false, reason: 'Authorization ヘッダが無い' });
    expect(verifyBearer(`Basic ${token}`, [key], now)).toMatchObject({ ok: false });
    expect(verifyBearer('Bearer', [key], now)).toMatchObject({ ok: false });
  });

  it('一覧から消した鍵（失効）は弾く', () => {
    expect(verifyBearer(`Bearer ${token}`, [other], now)).toMatchObject({ ok: false });
  });

  it('期限切れの鍵は弾き、理由に鍵の名前を残す', () => {
    expect(verifyBearer(`Bearer ${token}`, [{ ...key, expiresAt: '2026-11-22T11:59:59Z' }], now)).toEqual({
      ok: false,
      reason: `鍵 ${key.id} の期限が切れている`,
    });
  });
});

describe('parseKeys', () => {
  it('形の合う鍵だけを拾う', () => {
    const text = JSON.stringify({
      keys: [key, { ...key, id: '' }, { ...key, tokenHash: 'short' }, { ...key, expiresAt: 'someday' }, { ...key, tokenHash: undefined, secret: 'x' }, null],
    });
    expect(parseKeys(text)).toEqual([key]);
  });

  it('JSON でない値（作ったばかりのシークレットの乱数）は空にする', () => {
    expect(parseKeys('x%Y!random')).toEqual([]);
    expect(parseKeys(undefined)).toEqual([]);
    expect(parseKeys('{"keys":"no"}')).toEqual([]);
  });
});

it('daysLeft は期限までの日数を切り捨てで返す', () => {
  expect(daysLeft(key, now)).toBe(90);
  expect(daysLeft({ ...key, expiresAt: '2026-11-23T11:00:00Z' }, now)).toBe(0);
});
