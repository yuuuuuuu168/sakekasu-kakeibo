import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { aggregateMonth, carryOverBudget, totalsByCategory, transactionsOfMonth } from '../budget';
import { SEED_CATEGORIES, TRANSFER_ID } from '../categories';
import type { Budget, RecurringPayment, Transaction } from '../types';

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

describe('定期支払いと着地見込み', () => {
  const NETFLIX: RecurringPayment = {
    id: 'r1',
    label: 'Netflix',
    amount: 1590,
    categoryId: 'subscription',
    dayOfMonth: 25,
    startMonth: '2026-01',
  };

  it('まだ発生していない分を日割りとは別枠で足す', () => {
    const base = aggregateMonth({ month: '2026-09', transactions: TRANSACTIONS, categories: SEED_CATEGORIES, budget: BUDGET, today: '2026-09-15' });
    const withRecurring = aggregateMonth({
      month: '2026-09',
      transactions: TRANSACTIONS,
      categories: SEED_CATEGORIES,
      budget: BUDGET,
      today: '2026-09-15',
      recurring: [NETFLIX],
    });
    expect(withRecurring.projected).toBe(base.projected + 1590);
    expect(withRecurring.recurringRemaining).toBe(1590);
    expect(withRecurring.categories.find((row) => row.categoryId === 'subscription')?.recurring).toBe(1590);
  });

  it('既に取り込まれている定期支払いは二重に数えない', () => {
    const paid = txn('sub', '2026-09-25', 1590, [['subscription', 1590]]);
    paid.rawMerchant = 'NETFLIX.COM';
    paid.merchant = 'NETFLIXCOM';
    const transactions = [...TRANSACTIONS, paid];

    const summary = aggregateMonth({
      month: '2026-09',
      transactions,
      categories: SEED_CATEGORIES,
      budget: BUDGET,
      today: '2026-09-26',
      recurring: [NETFLIX],
    });

    // 実績に入っている 1,590 円はペースで伸ばさず、そのまま 1 回だけ数える
    const variable = 5300;
    const pace = 30 / 26;
    expect(summary.projected).toBe(Math.round(variable * pace) + 1590);
    expect(summary.recurringTotal).toBe(1590);
    expect(summary.recurringRemaining).toBe(0);
  });

  it('停止した定期支払いは見込みに入らない', () => {
    const summary = aggregateMonth({
      month: '2026-09',
      transactions: TRANSACTIONS,
      categories: SEED_CATEGORIES,
      today: '2026-09-15',
      recurring: [{ ...NETFLIX, archived: true }],
    });
    expect(summary.recurringTotal).toBe(0);
  });

  it('終わった月以降は見込みに出ない', () => {
    const ended: RecurringPayment = { ...NETFLIX, totalCount: 3 };
    const summary = aggregateMonth({
      month: '2026-09',
      transactions: TRANSACTIONS,
      categories: SEED_CATEGORIES,
      today: '2026-09-15',
      recurring: [ended],
    });
    expect(summary.recurringTotal).toBe(0);
  });

  it('定期支払いを渡さなければ従来どおりの日割りのまま', () => {
    const base = aggregateMonth({ month: '2026-09', transactions: TRANSACTIONS, categories: SEED_CATEGORIES, budget: BUDGET, today: '2026-09-15' });
    expect(base.projected).toBe(Math.round(base.total * (30 / 15)));
    expect(base.recurringTotal).toBe(0);
  });

  it('チャージの明細は定期支払いに当てない', () => {
    // 名前が当たるチャージ明細があっても、支出ではないので突き合わせの相手にしない
    const charge = txn('charge', '2026-09-25', 1590, [[TRANSFER_ID, 1590]]);
    charge.rawMerchant = 'NETFLIX.COM';
    charge.merchant = 'NETFLIXCOM';

    const summary = aggregateMonth({
      month: '2026-09',
      transactions: [...TRANSACTIONS, charge],
      categories: SEED_CATEGORIES,
      today: '2026-09-26',
      recurring: [NETFLIX],
    });

    expect(summary.recurringOccurrences[0].transactionId).toBeUndefined();
    expect(summary.recurringRemaining).toBe(1590);
    expect(summary.transferTotal).toBe(1590);
  });

  it('振替カテゴリで登録された定期支払いは見込みに乗らない', () => {
    const summary = aggregateMonth({
      month: '2026-09',
      transactions: TRANSACTIONS,
      categories: SEED_CATEGORIES,
      today: '2026-09-15',
      recurring: [{ ...NETFLIX, categoryId: TRANSFER_ID }],
    });
    expect(summary.recurringRemaining).toBe(0);
    expect(summary.categories.some((row) => row.categoryId === TRANSFER_ID)).toBe(false);
  });

  it('定期支払いの分を二重に数えない（プロパティ）', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50_000 }),
        fc.integer({ min: 1, max: 28 }),
        fc.integer({ min: 1, max: 28 }),
        fc.boolean(),
        (amount, dayOfMonth, todayDay, imported) => {
          const payment: RecurringPayment = { ...NETFLIX, amount, dayOfMonth };
          // 取り込み済みなら、同じ支払いが明細としても入っている状況
          const paid = txn('sub', `2026-09-${String(dayOfMonth).padStart(2, '0')}`, amount, [['subscription', amount]]);
          paid.rawMerchant = 'NETFLIX.COM';
          paid.merchant = 'NETFLIXCOM';
          const transactions = imported ? [...TRANSACTIONS, paid] : TRANSACTIONS;
          const today = `2026-09-${String(todayDay).padStart(2, '0')}`;

          const summary = aggregateMonth({ month: '2026-09', transactions, categories: SEED_CATEGORIES, today, recurring: [payment] });
          const bare = aggregateMonth({ month: '2026-09', transactions: TRANSACTIONS, categories: SEED_CATEGORIES, today });

          // 定期支払いの分はちょうど 1 回。日割りで伸ばす部分は定期支払いを含まない
          expect(summary.projected).toBe(bare.projected + amount);
          expect(summary.recurringTotal).toBe(amount);
          expect(summary.recurringRemaining).toBe(imported ? 0 : amount);
          expect(summary.projected).toBeGreaterThanOrEqual(summary.total);
        },
      ),
    );
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
