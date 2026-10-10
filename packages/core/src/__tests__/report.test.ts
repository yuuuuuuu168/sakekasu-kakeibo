import { describe, expect, it } from 'vitest';
import { buildMonthlyReport, determineLevel, topMerchants } from '../report';
import { SEED_CATEGORIES } from '../categories';
import type { Budget, CategoryRule, Transaction } from '../types';

function txn(id: string, date: string, amount: number, categoryId: string, merchant = 'セブンイレブン'): Transaction {
  return {
    id,
    date,
    amount,
    rawMerchant: merchant,
    merchant,
    source: 'credit',
    sourceLabel: '楽天カード',
    splits: [{ id: `${id}-1`, amount, categoryId, origin: 'manual' }],
    needsDetail: false,
  };
}

const LIMITS: Budget = { month: '2026-08', limits: { food: 30_000, hobby: 5_000, oshi: 10_000 } };

function report(transactions: Transaction[], budget: Budget = LIMITS) {
  return buildMonthlyReport({ month: '2026-08', transactions, categories: SEED_CATEGORIES, budget, generatedAt: '2026-09-01T00:00:00Z' });
}

describe('叱りの段階', () => {
  it('上限の 8 割以内で全部守れば天晴れ', () => {
    const result = report([txn('a', '2026-08-03', 20_000, 'food'), txn('b', '2026-08-04', 3_000, 'hobby')]);
    expect(result.scolding).toMatchObject({ level: 0, title: '天晴れ' });
  });

  it('守れてはいるが余裕が無ければ よし', () => {
    const result = report([txn('a', '2026-08-03', 29_000, 'food'), txn('b', '2026-08-04', 4_900, 'hobby'), txn('c', '2026-08-05', 9_000, 'oshi')]);
    expect(result.scolding.level).toBe(1);
  });

  it('1 カテゴリだけ小さく超えたら むむ', () => {
    const result = report([txn('a', '2026-08-03', 31_000, 'food')]);
    expect(result.scolding).toMatchObject({ level: 2, title: 'むむ' });
    expect(result.scolding.lines[0]).toContain('食費');
  });

  it('2 カテゴリ超過なら 喝', () => {
    const result = report([txn('a', '2026-08-03', 31_000, 'food'), txn('b', '2026-08-04', 5_500, 'hobby')]);
    expect(result.scolding).toMatchObject({ level: 3, title: '喝' });
  });

  it('上限の 2 倍を超えたカテゴリがあれば 激怒', () => {
    const result = report([txn('a', '2026-08-03', 11_000, 'oshi'), txn('b', '2026-08-10', 12_000, 'oshi')]);
    expect(result.scolding).toMatchObject({ level: 4, title: '激怒' });
    expect(result.scolding.lines.join('')).toContain('推し活');
  });

  it('上限が未設定なら判定せず、設定を促す', () => {
    const result = buildMonthlyReport({
      month: '2026-08',
      transactions: [txn('a', '2026-08-03', 50_000, 'food')],
      categories: SEED_CATEGORIES,
      generatedAt: '2026-09-01T00:00:00Z',
    });
    expect(result.hasLimits).toBe(false);
    expect(result.scolding.lines.join('')).toContain('上限');
  });

  it('内訳待ちがあれば数字が甘いことを添える', () => {
    const pending = { ...txn('a', '2026-08-03', 20_000, 'food'), needsDetail: true };
    const result = report([pending]);
    expect(result.scolding.lines.at(-1)).toContain('内訳が未確定');
  });
});

describe('determineLevel', () => {
  it('超過の合計が上限総額の 2 割を超えたら 激怒', () => {
    const level = determineLevel({
      total: 60_000,
      limitTotal: 45_000,
      overTotal: 15_000,
      overCategories: [{ categoryId: 'food', label: '食費', actual: 45_000, limit: 30_000, usage: 1.5, over: 15_000, projected: 45_000, recurring: 0 }],
      worst: [],
      needsDetailCount: 0,
      hasLimits: true,
    });
    expect(level).toBe(4);
  });
});

describe('レポートの中身', () => {
  it('超過の大きい順に 3 件まで並べる', () => {
    const result = report([
      txn('a', '2026-08-03', 40_000, 'food'),
      txn('b', '2026-08-04', 9_000, 'hobby'),
      txn('c', '2026-08-05', 12_000, 'oshi'),
    ]);
    expect(result.worst.map((row) => row.categoryId)).toEqual(['food', 'hobby', 'oshi']);
    expect(result.overTotal).toBe(10_000 + 4_000 + 2_000);
  });

  it('前月との差を出す', () => {
    const result = report([txn('a', '2026-08-03', 20_000, 'food'), txn('p', '2026-07-03', 15_000, 'food')]);
    expect(result.previousTotal).toBe(15_000);
    expect(result.deltaFromPrevious).toBe(5_000);
  });

  it('前月の明細が無ければ比較を付けない', () => {
    const result = report([txn('a', '2026-08-03', 20_000, 'food')]);
    expect(result.previousTotal).toBeUndefined();
  });

  it('店舗別の合計を多い順に返す', () => {
    const totals = topMerchants([
      txn('a', '2026-08-01', 1_200, 'food', 'セブンイレブン'),
      txn('b', '2026-08-02', 800, 'food', 'セブンイレブン'),
      txn('c', '2026-08-03', 3_480, 'daily', 'AMAZONCOJP'),
      txn('d', '2026-08-04', -500, 'daily', 'AMAZONCOJP'),
    ]);
    expect(totals[0]).toMatchObject({ merchant: 'AMAZONCOJP', amount: 3_480, count: 1 });
    expect(totals[1]).toMatchObject({ merchant: 'セブンイレブン', amount: 2_000, count: 2 });
  });
});

/** 型だけ使う。ルールの型が report から見えることの確認 */
const _rule: CategoryRule | undefined = undefined;
void _rule;
