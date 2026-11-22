import { describe, expect, it } from 'vitest';
import { AUTH_BACKOFF_MS, MAX_PER_RUN, parseRelayConfig, pickUids, planRun, shouldTryLogin } from '../plan';

describe('planRun', () => {
  it('初回は今の最新を基準にして、過去のメールを送らない', () => {
    expect(planRun({ authFailures: 0 }, { uidValidity: '7', uidNext: 1201 })).toEqual({ kind: 'baseline', lastUid: 1200, reason: '初回' });
  });

  it('続きからは、最後に送った UID より後を取りに行く（止まっていた間の分も含む）', () => {
    expect(planRun({ authFailures: 0, uidValidity: '7', lastUid: 1100 }, { uidValidity: '7', uidNext: 1201 })).toEqual({
      kind: 'fetch',
      afterUid: 1100,
    });
  });

  it('UIDVALIDITY が変わったら数え直す', () => {
    expect(planRun({ authFailures: 0, uidValidity: '7', lastUid: 1100 }, { uidValidity: '8', uidNext: 5 })).toEqual({
      kind: 'baseline',
      lastUid: 4,
      reason: 'UIDVALIDITY が変わった',
    });
  });
});

describe('pickUids', () => {
  it('基準より後だけを古い順に選ぶ（`N:*` が返す最後の 1 通は落とす）', () => {
    expect(pickUids([1200, 1203, 1201, 1201], 1200)).toEqual([1201, 1203]);
    expect(pickUids([1200], 1200)).toEqual([]);
  });

  it('1 回に送るのは上限まで。残りは次の回', () => {
    const uids = Array.from({ length: MAX_PER_RUN + 10 }, (_, index) => 101 + index);
    expect(pickUids(uids, 100)).toEqual(uids.slice(0, MAX_PER_RUN));
  });
});

describe('shouldTryLogin', () => {
  const now = new Date('2026-11-22T12:00:00Z');
  it('失敗が 2 回までなら毎回試す', () => {
    expect(shouldTryLogin({ authFailures: 2, lastAuthFailureAt: now.toISOString() }, now)).toBe(true);
  });

  it('3 回続いたら 1 時間に 1 回まで', () => {
    const recent = new Date(now.getTime() - AUTH_BACKOFF_MS + 60_000).toISOString();
    const old = new Date(now.getTime() - AUTH_BACKOFF_MS).toISOString();
    expect(shouldTryLogin({ authFailures: 3, lastAuthFailureAt: recent }, now)).toBe(false);
    expect(shouldTryLogin({ authFailures: 3, lastAuthFailureAt: old }, now)).toBe(true);
  });
});

describe('parseRelayConfig', () => {
  it('ID・パスワード・送り先が揃ったものだけを読む', () => {
    const config = { user: 'me', password: 'pw', forwardTo: 'inbox@example.com' };
    expect(parseRelayConfig(JSON.stringify(config))).toEqual(config);
    expect(parseRelayConfig(JSON.stringify({ ...config, forwardTo: 'not-an-address' }))).toBeUndefined();
    expect(parseRelayConfig(JSON.stringify({ ...config, password: '' }))).toBeUndefined();
    expect(parseRelayConfig('random-initial-value')).toBeUndefined();
    expect(parseRelayConfig(undefined)).toBeUndefined();
  });
});
