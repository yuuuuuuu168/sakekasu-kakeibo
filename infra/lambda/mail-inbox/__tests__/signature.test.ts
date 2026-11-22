import { describe, expect, it } from 'vitest';
import { MAX_CLOCK_SKEW_SECONDS, daysLeft, parseKeys, sign, verifyRequest, type InboxKey } from '../signature';

const now = new Date('2026-11-22T12:00:00Z');
const key: InboxKey = {
  id: 'muse-20261122-ab12',
  secret: 'a'.repeat(64),
  sub: 'sub-1',
  expiresAt: '2027-02-20T12:00:00Z',
};
const body = Buffer.from('{"date":"2026-11-22","title":"アイマスク"}', 'utf-8');
const timestamp = String(Math.floor(now.getTime() / 1000));

function request(overrides: Partial<Parameters<typeof verifyRequest>[0]> = {}) {
  return verifyRequest({
    keyId: key.id,
    timestamp,
    signature: sign(key.secret, timestamp, body),
    body,
    keys: [key],
    now,
    ...overrides,
  });
}

describe('verifyRequest', () => {
  it('正しい署名なら鍵を返す', () => {
    expect(request()).toEqual({ ok: true, key });
  });

  it('openssl と同じ作り方の署名を通す（printf "%s.%s" | openssl dgst -sha256 -hmac）', () => {
    // 署名する文字列は "<Timestamp>.<本文>" を UTF-8 にしたもの
    const expected = sign(key.secret, timestamp, body);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
    expect(request({ signature: expected.toUpperCase() }).ok).toBe(true);
  });

  it('本文が 1 バイトでも違えば弾く', () => {
    const changed = Buffer.from(body.toString('utf-8').replace('アイマスク', 'アイマスク '), 'utf-8');
    expect(request({ body: changed })).toMatchObject({ ok: false, reason: '署名が合わない' });
  });

  it('時刻を書き換えると署名が合わない', () => {
    expect(request({ timestamp: String(Number(timestamp) + 1) })).toMatchObject({ ok: false, reason: '署名が合わない' });
  });

  it('5 分を超えてずれた送信時刻は弾く', () => {
    const late = String(Number(timestamp) - MAX_CLOCK_SKEW_SECONDS - 1);
    expect(request({ timestamp: late, signature: sign(key.secret, late, body) })).toMatchObject({ ok: false });
    const edge = String(Number(timestamp) - MAX_CLOCK_SKEW_SECONDS);
    expect(request({ timestamp: edge, signature: sign(key.secret, edge, body) }).ok).toBe(true);
  });

  it('知らない鍵・期限切れの鍵・ヘッダの欠けは弾く', () => {
    expect(request({ keyId: 'other' })).toMatchObject({ ok: false });
    expect(request({ keys: [{ ...key, expiresAt: '2026-11-22T11:59:59Z' }] })).toMatchObject({ ok: false, reason: '鍵の期限が切れている' });
    expect(request({ signature: undefined })).toMatchObject({ ok: false });
    expect(request({ signature: 'zz' })).toMatchObject({ ok: false });
    expect(request({ timestamp: '1.5' })).toMatchObject({ ok: false });
  });

  it('別の鍵で作った署名は弾く', () => {
    expect(request({ signature: sign('b'.repeat(64), timestamp, body) })).toMatchObject({ ok: false });
  });
});

describe('parseKeys', () => {
  it('形の合う鍵だけを拾う', () => {
    const text = JSON.stringify({
      keys: [key, { ...key, id: '' }, { ...key, secret: 'short' }, { ...key, expiresAt: 'someday' }, null],
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
