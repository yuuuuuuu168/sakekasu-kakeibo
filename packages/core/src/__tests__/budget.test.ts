import { describe, expect, it } from 'vitest';
import { aggregateMonth, carryOverBudget, totalsByCategory, transactionsOfMonth } from '../budget';
import { SEED_CATEGORIES } from '../categories';
import type { Budget, Transaction } from '../types';

function txn(id: string, date: string, amount: number, splits: [string, number][], needsDetail = false): Transaction {
  return {
    id,
    date,
    amount,
    rawMerchant: `店${id}`,
    merchant: `店${id}`,
    source: 'credit',
    sourceLabel: '楽天カード',
    splits: splits.map(([categoryId, value], index) => ({ id: `${id}-${index}`, amount: value, categoryId, origin: 'manual' as const })),
    needsDetail,
  };
}

const TRANSACTIONS: Transaction[] = [
  txn('a', '2026-09-01', 1200, [['food', 800], ['daily', 400]]),
  txn('b', '2026-09-05', 3480, [['daily', 3480]], true),
  txn('c', '2026-09-10', 620, [['cafe', 620]]),
  txn('d', '2026-08-30', 5000, [['food', 5000]]),
];

const BUDGET: Budget = { month: '2026-09', limits: { food: 40_000, daily: 5_000, cafe: 3_000 } };

describe('aggregateMonth', () => {
  it('明細の合計ではなく内訳を足す', () => {
    const totals = totalsByCategory(transactionsOfMonth(TRANSACTIONS, '2026-09'));
    expect(totals.get('food')).toBe(800);
    expect(totals.get('daily')).toBe(3880);
    expect(totals.get('cafe')).toBe(620);
  });

  it('当月だけを見る', () => {
    const summary = aggregateMonth({ month: '2026-09', transactions: TRANSACTIONS, categories: SEED_CATEGORIES, budget: BUDGET, today: '2026-09-15' });
    expect(summary.total).toBe(5300);
    expect(summary.transactionCount).toBe(3);
  });

  it('上限と超過額を出す', () => {
    const summary = aggregateMonth({ month: '2026-09', transactions: TRANSACTIONS, categories: SEED_CATEGORIES, budget: BUDGET, today: '2026-09-15' });
    const daily = summary.categories.find((row) => row.categoryId === 'daily');
    expect(daily).toMatchObject({ actual: 3880, limit: 5000, over: 0 });
    expect(daily?.usage).toBeCloseTo(0.776);
  });

  it('経過日数から月末の着地を見込む', () => {
    const summary = aggregateMonth({ month: '2026-09', transactions: TRANSACTIONS, categories: SEED_CATEGORIES, budget: BUDGET, today: '2026-09-15' });
    // 15 日で 5,300 円なら 30 日で倍
    expect(summary.projected).toBe(10_600);
  });

  it('内訳待ちの件数を数える', () => {
    const summary = aggregateMonth({ month: '2026-09', transactions: TRANSACTIONS, categories: SEED_CATEGORIES, budget: BUDGET, today: '2026-09-15' });
    expect(summary.needsDetailCount).toBe(1);
  });

  it('明細が無い月でも落ちない', () => {
    const summary = aggregateMonth({ month: '2026-07', transactions: TRANSACTIONS, categories: SEED_CATEGORIES, today: '2026-09-15' });
    expect(summary.total).toBe(0);
    expect(summary.limitTotal).toBe(0);
    expect(summary.projected).toBe(0);
  });

  it('上限が無いカテゴリに支出があっても usage は有限（保存で弾かれない）', () => {
    // food の上限を外し、支出だけ残す。ratio なら Infinity になる状況
    const budget: Budget = { month: '2026-09', limits: { daily: 5_000 } };
    const summary = aggregateMonth({ month: '2026-09', transactions: TRANSACTIONS, categories: SEED_CATEGORIES, budget, today: '2026-09-15' });
    const food = summary.categories.find((row) => row.categoryId === 'food');
    expect(food?.actual).toBeGreaterThan(0);
    expect(food?.limit).toBe(0);
    expect(Number.isFinite(food?.usage)).toBe(true);
    // 非有限な数が混ざっていないこと。DynamoDB / JSON はこれを弾く
    for (const row of summary.categories) expect(Number.isFinite(row.usage)).toBe(true);
    expect(JSON.stringify(summary)).not.toContain('null');
  });
});

describe('carryOverBudget', () => {
  it('前月の上限をそのまま持ってくる', () => {
    const next = carryOverBudget(BUDGET, '2026-10');
    expect(next).toEqual({ month: '2026-10', limits: BUDGET.limits });
    next.limits.food = 1;
    expect(BUDGET.limits.food).toBe(40_000);
  });
});
