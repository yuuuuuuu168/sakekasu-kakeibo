import { describe, expect, it } from 'vitest';
import { SK, snapshotFromItems } from '../snapshot-items';

describe('snapshotFromItems', () => {
  it('行の種類ごとに振り分け、キーの列は外す', () => {
    const snapshot = snapshotFromItems([
      { pk: 'USER#u1', sk: SK.transaction('t1'), id: 't1', amount: 100 },
      { pk: 'USER#u1', sk: SK.categories, categories: [{ id: 'food', label: '食費', order: 1 }] },
      { pk: 'USER#u1', sk: SK.rules, rules: [{ id: 'r' }] },
      { pk: 'USER#u1', sk: SK.recurring, recurring: [{ id: 'rp' }] },
      { pk: 'USER#u1', sk: SK.budget('2026-09'), month: '2026-09', limits: { food: 1 } },
      { pk: 'USER#u1', sk: SK.receipt('rc1'), id: 'rc1' },
      { pk: 'USER#u1', sk: SK.mapping('credit'), sourceId: 'credit' },
    ]);

    expect(snapshot.transactions).toEqual([{ id: 't1', amount: 100 }]);
    expect(snapshot.categories).toEqual([{ id: 'food', label: '食費', order: 1 }]);
    expect(snapshot.rules).toEqual([{ id: 'r' }]);
    expect(snapshot.recurring).toEqual([{ id: 'rp' }]);
    expect(snapshot.budgets).toEqual([{ month: '2026-09', limits: { food: 1 } }]);
    expect(snapshot.receipts).toEqual([{ id: 'rc1' }]);
    expect(snapshot.mappings).toEqual([{ sourceId: 'credit' }]);
  });

  it('補わない。カテゴリの行が無ければ空のまま返す（補うのは core の normalizeSnapshot）', () => {
    expect(snapshotFromItems([]).categories).toEqual([]);
  });

  it('レポートの行は保存データではないので拾わない', () => {
    const snapshot = snapshotFromItems([{ pk: 'USER#u1', sk: SK.report('2026-09'), report: {} }]);
    expect(Object.values(snapshot).every((list) => list.length === 0)).toBe(true);
  });
});
