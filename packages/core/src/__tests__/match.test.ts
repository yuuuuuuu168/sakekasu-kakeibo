import { describe, expect, it } from 'vitest';
import { AUTO_MATCH_SCORE, autoMatch, findCandidates } from '../receipt/match';
import type { Receipt, Transaction } from '../types';

function txn(partial: Partial<Transaction> & { id: string; date: string; amount: number; rawMerchant: string }): Transaction {
  return {
    merchant: partial.rawMerchant,
    source: 'credit',
    sourceLabel: '楽天カード',
    splits: [{ id: `${partial.id}-1`, amount: partial.amount, categoryId: 'food', origin: 'rule' }],
    needsDetail: true,
    ...partial,
  };
}

const RECEIPT: Receipt = {
  id: 'r1',
  storeName: 'セブン-イレブン品川駅前店',
  date: '2026-09-01',
  total: 1200,
  items: [],
  status: 'pending',
};

describe('findCandidates', () => {
  it('金額が一致する明細だけを候補にする', () => {
    const candidates = findCandidates(RECEIPT, [
      txn({ id: 'a', date: '2026-09-01', amount: 1200, rawMerchant: 'セブン－イレブン品川' }),
      txn({ id: 'b', date: '2026-09-01', amount: 1201, rawMerchant: 'セブン－イレブン品川' }),
    ]);
    expect(candidates.map((candidate) => candidate.txn.id)).toEqual(['a']);
  });

  it('カードの計上日ずれを 4 日まで見る', () => {
    const candidates = findCandidates(RECEIPT, [
      txn({ id: 'a', date: '2026-09-05', amount: 1200, rawMerchant: 'セブン－イレブン品川' }),
      txn({ id: 'b', date: '2026-09-06', amount: 1200, rawMerchant: 'セブン－イレブン品川' }),
    ]);
    expect(candidates.map((candidate) => candidate.txn.id)).toEqual(['a']);
  });

  it('別のレシートが既に付いた明細は候補から外す', () => {
    const candidates = findCandidates(RECEIPT, [
      txn({ id: 'a', date: '2026-09-01', amount: 1200, rawMerchant: 'セブン－イレブン品川', receiptId: 'r9' }),
    ]);
    expect(candidates).toHaveLength(0);
  });

  it('同じ日で店名も合えば自動で紐付く点数になる', () => {
    const candidates = findCandidates(RECEIPT, [txn({ id: 'a', date: '2026-09-01', amount: 1200, rawMerchant: 'セブン－イレブン品川' })]);
    expect(candidates[0].score).toBeGreaterThanOrEqual(AUTO_MATCH_SCORE);
    expect(autoMatch(candidates)?.id).toBe('a');
  });
});

describe('autoMatch', () => {
  it('高い候補が 2 件あれば人間に選ばせる', () => {
    const candidates = findCandidates(RECEIPT, [
      txn({ id: 'a', date: '2026-09-01', amount: 1200, rawMerchant: 'セブン－イレブン品川' }),
      txn({ id: 'b', date: '2026-09-01', amount: 1200, rawMerchant: 'セブン－イレブン五反田' }),
    ]);
    expect(candidates).toHaveLength(2);
    expect(autoMatch(candidates)).toBeUndefined();
  });

  it('店名が全く違えば自動では紐付けない', () => {
    const candidates = findCandidates(RECEIPT, [txn({ id: 'a', date: '2026-09-04', amount: 1200, rawMerchant: 'ドン・キホーテ' })]);
    expect(autoMatch(candidates)).toBeUndefined();
  });

  it('候補ゼロなら現金払いとして扱える', () => {
    expect(findCandidates(RECEIPT, [])).toHaveLength(0);
  });
});
