import { describe, expect, it } from 'vitest';
import { SEED_CATEGORIES, type Receipt } from '@kakeibo/core';
import type { Draft } from '../../ocr-receipt/draft';
import { f1, scoreClassify, scoreOcr } from '../score';
import { costUsd, priceOf } from '../pricing';

const truth: Receipt = {
  id: 'r1',
  storeName: 'ローソン 横浜駅店',
  date: '2026-10-01',
  total: 398,
  items: [
    { name: 'おにぎり 鮭', amount: 158, categoryId: 'food' },
    { name: 'ティッシュ', amount: 240, categoryId: 'daily' },
  ],
  status: 'matched',
};

function draft(overrides: Partial<Draft> = {}): Draft {
  return {
    storeName: 'ローソン　横浜駅店',
    date: '2026-10-01',
    total: 398,
    items: [
      { name: 'おにぎり鮭', amount: 158, categoryId: 'food' },
      { name: 'ティッシュ', amount: 240, categoryId: 'daily' },
    ],
    warnings: [],
    ...overrides,
  };
}

describe('scoreOcr', () => {
  it('空白と全角半角の違いは見ずに、全部合えば満点', () => {
    expect(scoreOcr(truth, draft())).toMatchObject({
      total: true,
      date: true,
      store: true,
      currency: true,
      exactItems: 2,
      amountItems: 2,
      itemF1: 1,
      amountF1: 1,
      balanced: true,
    });
  });

  it('名前を読み違えても金額が合えば、amount の側だけ当たりに数える', () => {
    const score = scoreOcr(truth, draft({ items: [{ name: 'オニギリ', amount: 158, categoryId: 'food' }, { name: 'ティッシュ', amount: 240, categoryId: 'daily' }] }));
    expect(score.exactItems).toBe(1);
    expect(score.amountItems).toBe(2);
    expect(score.itemF1).toBeCloseTo(0.5);
  });

  it('読み落としと二重取りは F1 を下げ、合計とのずれも拾う', () => {
    const score = scoreOcr(
      truth,
      draft({ total: 398, items: [{ name: 'おにぎり 鮭', amount: 158, categoryId: 'food' }, { name: 'おにぎり 鮭', amount: 158, categoryId: 'food' }] }),
    );
    expect(score.exactItems).toBe(1);
    expect(score.balanced).toBe(false);
  });

  it('通貨が違えば合計の数字が同じでも外れ', () => {
    expect(scoreOcr(truth, draft({ currency: 'USD' })).total).toBe(false);
  });
});

describe('f1', () => {
  it('どちらも 0 件なら 1、片方だけ 0 件なら 0', () => {
    expect(f1(0, 0, 0)).toBe(1);
    expect(f1(0, 3, 0)).toBe(0);
    expect(f1(2, 4, 2)).toBeCloseTo(2 / 3);
  });
});

describe('scoreClassify', () => {
  const categories = [...SEED_CATEGORIES, { id: 'food-rice', label: '米', order: 1, parentId: 'food' }];

  it('小カテゴリまでの一致、大カテゴリまでの一致、人が直した品目を分けて数える', () => {
    const score = scoreClassify(
      {
        '0': { truth: 'food-rice', ruled: true },
        '1': { truth: 'food', ruled: false },
        '2': { truth: 'daily', ruled: false },
      },
      {
        '0': { categoryId: 'food-rice', status: 'accepted' },
        '1': { categoryId: 'food-rice', status: 'review' },
        '2': undefined,
      },
      categories,
    );
    expect(score).toEqual({
      subjects: 3,
      exact: 1,
      root: 2,
      ruled: 1,
      ruledExact: 1,
      accepted: 1,
      review: 1,
      unresolved: 1,
      acceptedExact: 1,
    });
  });
});

describe('pricing', () => {
  it('思考を含む出力と入力を、100 万トークンあたりの値で足す', () => {
    const price = priceOf('claude-opus-5-5')!;
    expect(costUsd({ input: 1_000_000, output: 100_000, thinking: 50_000, cacheRead: 0, cacheWrite: 0 }, price)).toBeCloseTo(6);
  });

  it('表に無いモデルは、渡された値があるときだけ数えられる', () => {
    expect(priceOf('claude-unknown-9')).toBeUndefined();
    expect(priceOf('claude-unknown-9', { input: 1, output: 2 })).toEqual({ input: 1, output: 2 });
  });
});
