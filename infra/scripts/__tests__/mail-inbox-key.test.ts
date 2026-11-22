import { describe, expect, it } from 'vitest';
import { parseKeys, verifyBearer } from '../../lambda/mail-inbox/token';
import { DEFAULT_KEY_DAYS, issueKey, keepUsable } from '../mail-inbox-key';

const now = new Date('2026-11-22T00:00:00Z');

describe('mail-inbox-key', () => {
  it('発行した鍵は Lambda がそのまま読める形で、出したトークンで通り、期限は 90 日後', () => {
    const { key, token } = issueKey('sub-1', now);
    const keys = parseKeys(JSON.stringify({ keys: [key] }));
    expect(keys).toEqual([key]);
    expect(verifyBearer(`Bearer ${token}`, keys, now)).toEqual({ ok: true, key });
    expect(Date.parse(key.expiresAt) - now.getTime()).toBe(DEFAULT_KEY_DAYS * 86_400_000);
  });

  it('シークレットに入る値にトークンそのものは含まれない', () => {
    const { key, token } = issueKey('sub-1', now);
    expect(JSON.stringify(key)).not.toContain(token);
    expect(JSON.stringify(key)).not.toContain(token.slice(4, 20));
  });

  it('毎回ちがうトークンを作る', () => {
    expect(issueKey('sub-1', now).token).not.toBe(issueKey('sub-1', now).token);
  });

  it('期限切れの鍵と、失効させる鍵を落とす', () => {
    const live = issueKey('sub-1', now).key;
    const expired = { ...issueKey('sub-1', now).key, id: 'old', expiresAt: '2026-11-01T00:00:00Z' };
    const revoked = { ...issueKey('sub-1', now).key, id: 'leaked' };
    expect(keepUsable([live, expired, revoked], now, 'leaked')).toEqual([live]);
  });
});
