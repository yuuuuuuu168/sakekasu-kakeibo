import { describe, expect, it } from 'vitest';
import { parseKeys } from '../../lambda/mail-inbox/signature';
import { DEFAULT_KEY_DAYS, issueKey, keepUsable } from '../mail-inbox-key';

const now = new Date('2026-11-22T00:00:00Z');

describe('mail-inbox-key', () => {
  it('発行した鍵は Lambda がそのまま読める形で、期限は 90 日後', () => {
    const key = issueKey('sub-1', now);
    expect(parseKeys(JSON.stringify({ keys: [key] }))).toEqual([key]);
    expect(key.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(Date.parse(key.expiresAt) - now.getTime()).toBe(DEFAULT_KEY_DAYS * 86_400_000);
  });

  it('毎回ちがう秘密の値を作る', () => {
    expect(issueKey('sub-1', now).secret).not.toBe(issueKey('sub-1', now).secret);
  });

  it('期限切れの鍵と、失効させる鍵を落とす', () => {
    const live = issueKey('sub-1', now);
    const expired = { ...issueKey('sub-1', now), id: 'old', expiresAt: '2026-11-01T00:00:00Z' };
    const revoked = { ...issueKey('sub-1', now), id: 'leaked' };
    expect(keepUsable([live, expired, revoked], now, 'leaked')).toEqual([live]);
  });
});
