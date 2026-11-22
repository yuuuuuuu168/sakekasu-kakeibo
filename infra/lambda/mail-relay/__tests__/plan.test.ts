import { describe, expect, it } from 'vitest';
import {
  AUTH_BACKOFF_MS,
  MAX_MESSAGE_AGE_MS,
  MAX_PER_RUN,
  isTooOld,
  isWatchedFolder,
  orderFolders,
  parseRelayConfig,
  pickUids,
  planRun,
  shouldTryLogin,
  stateFromItem,
} from '../plan';

describe('planRun', () => {
  it('初めて見るフォルダは今の最新を基準にして、過去のメールは送らない', () => {
    expect(planRun(undefined, { uidValidity: '7', uidNext: 1201 })).toEqual({ kind: 'baseline', lastUid: 1200, reason: '初回' });
  });

  it('続きからは、最後に送った UID より後を取りに行く（止まっていた間の分も含む）', () => {
    expect(planRun({ uidValidity: '7', lastUid: 1100 }, { uidValidity: '7', uidNext: 1201 })).toEqual({ kind: 'fetch', afterUid: 1100 });
  });

  it('UIDVALIDITY が変わったら数え直す', () => {
    expect(planRun({ uidValidity: '7', lastUid: 1100 }, { uidValidity: '8', uidNext: 5 })).toEqual({
      kind: 'baseline',
      lastUid: 4,
      reason: 'UIDVALIDITY が変わった',
    });
  });
});

describe('stateFromItem', () => {
  it('受信箱しか見ていなかった頃の行は、受信箱の進み具合として読み替える', () => {
    expect(stateFromItem({ uidValidity: '7', lastUid: 408777, authFailures: 0 })).toEqual({
      folders: { INBOX: { uidValidity: '7', lastUid: 408777 } },
      authFailures: 0,
    });
  });

  it('フォルダごとの行を読み、形の崩れたものは落とす', () => {
    expect(
      stateFromItem({ folders: { INBOX: { uidValidity: '7', lastUid: 5 }, 買い物: { uidValidity: '9', lastUid: 2 }, 壊れ: { lastUid: 'x' } }, authFailures: 2, lastAuthFailureAt: '2026-11-22T00:00:00Z' }),
    ).toEqual({
      folders: { INBOX: { uidValidity: '7', lastUid: 5 }, 買い物: { uidValidity: '9', lastUid: 2 } },
      authFailures: 2,
      lastAuthFailureAt: '2026-11-22T00:00:00Z',
    });
    expect(stateFromItem(undefined)).toEqual({ folders: {}, authFailures: 0 });
  });
});

describe('isWatchedFolder', () => {
  const folder = (path: string, specialUse?: string, flags: string[] = []) => ({ path, name: path.split('/').pop()!, specialUse, flags: new Set(flags) });

  it('受信箱と個人フォルダは見る', () => {
    expect(isWatchedFolder(folder('INBOX', '\\Inbox'))).toBe(true);
    expect(isWatchedFolder(folder('買い物'))).toBe(true);
    expect(isWatchedFolder(folder('仕事/請求'))).toBe(true);
  });

  it('迷惑メール・ゴミ箱・送信済み・下書きは、印でも名前でも外す', () => {
    for (const special of ['\\Sent', '\\Drafts', '\\Trash', '\\Junk', '\\All', '\\Flagged']) {
      expect(isWatchedFolder(folder('なんでも', special))).toBe(false);
    }
    // Yahoo! JAPAN の既定のフォルダ名
    for (const name of ['Bulk Mail', 'Sent', 'Draft', 'Trash', '迷惑メール', 'ゴミ箱']) {
      expect(isWatchedFolder(folder(name))).toBe(false);
    }
  });

  it('選べないフォルダ（階層だけのもの）は外す', () => {
    expect(isWatchedFolder(folder('仕事', undefined, ['\\Noselect']))).toBe(false);
  });
});

describe('isTooOld', () => {
  const now = new Date('2026-11-22T12:00:00Z');
  it('届いてから 1 日より古いメールは送らない', () => {
    expect(isTooOld(new Date(now.getTime() - MAX_MESSAGE_AGE_MS - 1000), now)).toBe(true);
    expect(isTooOld(new Date(now.getTime() - MAX_MESSAGE_AGE_MS + 1000), now)).toBe(false);
    expect(isTooOld('2026-11-22T11:00:00Z', now)).toBe(false);
  });

  it('届いた日時が分からなければ送る（取りこぼさない側に倒す）', () => {
    expect(isTooOld(undefined, now)).toBe(false);
    expect(isTooOld('not a date', now)).toBe(false);
  });
});

it('受信箱を先に、残りは名前の順に並べる', () => {
  expect(orderFolders(['買い物', 'INBOX', 'A'])).toEqual(['INBOX', 'A', '買い物']);
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

  it('ほかのフォルダで使った分を引いた上限まで（0 以下なら選ばない）', () => {
    expect(pickUids([1, 2, 3], 0, 2)).toEqual([1, 2]);
    expect(pickUids([1, 2, 3], 0, 0)).toEqual([]);
    expect(pickUids([1, 2, 3], 0, -1)).toEqual([]);
  });
});

describe('shouldTryLogin', () => {
  const now = new Date('2026-11-22T12:00:00Z');
  it('失敗が 2 回までなら毎回試す', () => {
    expect(shouldTryLogin({ folders: {}, authFailures: 2, lastAuthFailureAt: now.toISOString() }, now)).toBe(true);
  });

  it('3 回続いたら 1 時間に 1 回まで', () => {
    const recent = new Date(now.getTime() - AUTH_BACKOFF_MS + 60_000).toISOString();
    const old = new Date(now.getTime() - AUTH_BACKOFF_MS).toISOString();
    expect(shouldTryLogin({ folders: {}, authFailures: 3, lastAuthFailureAt: recent }, now)).toBe(false);
    expect(shouldTryLogin({ folders: {}, authFailures: 3, lastAuthFailureAt: old }, now)).toBe(true);
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
