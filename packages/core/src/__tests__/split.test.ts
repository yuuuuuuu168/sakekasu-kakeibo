import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { distribute, isBalanced, rebalance, splitByAmounts, splitEvenly, splitsFromReceipt, sumSplits, applyReceipt } from '../receipt/split';
import { classifyItem } from '../receipt/items';
import type { Receipt, Transaction } from '../types';

const CONBINI_RECEIPT: Receipt = {
  id: 'r1',
  storeName: 'セブン-イレブン品川駅前店',
  date: '2026-09-01',
  total: 1200,
  status: 'pending',
  items: [
    { name: '直巻おにぎり 鮭', amount: 150 },
    { name: 'ティッシュ 5箱', amount: 398 },
    { name: 'ブレンドコーヒー R', amount: 120 },
    { name: 'アサヒスーパードライ 350ml', amount: 217 },
    { name: 'サラダチキン', amount: 250 },
  ],
};

const TXN: Transaction = {
  id: 't1',
  date: '2026-09-01',
  amount: 1200,
  rawMerchant: 'セブン－イレブン品川',
  merchant: 'セブンイレブン品川',
  source: 'credit',
  sourceLabel: '楽天カード',
  splits: [{ id: 's1', amount: 1200, categoryId: 'food', origin: 'rule' }],
  needsDetail: true,
};

describe('classifyItem', () => {
  it('品目名からカテゴリを当てる', () => {
    expect(classifyItem('直巻おにぎり 鮭')).toBe('food');
    expect(classifyItem('ティッシュ 5箱')).toBe('daily');
    expect(classifyItem('ブレンドコーヒー R')).toBe('cafe');
    expect(classifyItem('アサヒスーパードライ 350ml')).toBe('alcohol');
    expect(classifyItem('カップ麺 醤油')).toBe('food');
    expect(classifyItem('謎の商品')).toBe('uncategorized');
  });

  it('OCR の推定を優先し、未分類のときだけ表で拾う', () => {
    expect(classifyItem('ティッシュ', 'daily')).toBe('daily');
    expect(classifyItem('アサヒスーパードライ', 'alcohol')).toBe('alcohol');
    expect(classifyItem('ティッシュ', 'uncategorized')).toBe('daily');
  });
});

describe('splitsFromReceipt', () => {
  it('コンビニの 1 回の支払いを品目ごとに割る', () => {
    const splits = splitsFromReceipt(CONBINI_RECEIPT, 1200);
    expect(splits).toHaveLength(5);
    expect(splits.map((split) => split.categoryId)).toEqual(['food', 'daily', 'cafe', 'alcohol', 'food']);
    expect(splits.every((split) => split.origin === 'receipt')).toBe(true);
  });

  it('品目合計と請求額のずれを品目に按分する', () => {
    // 品目合計 1135 に対して請求 1200。消費税や値引きのぶんが 65 円ずれている
    const splits = splitsFromReceipt(CONBINI_RECEIPT, 1200);
    expect(sumSplits(splits)).toBe(1200);
    expect(splits.every((split) => split.amount > 0)).toBe(true);
  });

  it('品目が無いレシートは 1 行の未分類にする', () => {
    const splits = splitsFromReceipt({ ...CONBINI_RECEIPT, items: [] }, 1200);
    expect(splits).toEqual([{ id: 'split-1', amount: 1200, categoryId: 'uncategorized', origin: 'receipt' }]);
  });

  it('レシートを当てると内訳待ちが下りる', () => {
    const applied = applyReceipt(TXN, CONBINI_RECEIPT);
    expect(applied.needsDetail).toBe(false);
    expect(applied.receiptId).toBe('r1');
    expect(sumSplits(applied.splits)).toBe(applied.amount);
  });
});

describe('手で割る', () => {
  it('均等割りの端数も合計に含まれる', () => {
    const splits = splitEvenly(1000, ['food', 'daily', 'cafe']);
    expect(splits.map((split) => split.amount).sort((a, b) => b - a)).toEqual([334, 333, 333]);
    expect(sumSplits(splits)).toBe(1000);
  });

  it('入れた金額の残りが最後の行に入る', () => {
    const splits = splitByAmounts(1200, [{ categoryId: 'food', amount: 800 }, { categoryId: 'daily' }]);
    expect(splits.map((split) => split.amount)).toEqual([800, 400]);
  });

  it('入れすぎたら最後の行がマイナスにならないよう総額で辻褄を合わせる', () => {
    const splits = splitByAmounts(1200, [{ categoryId: 'food', amount: 1500 }, { categoryId: 'daily' }]);
    expect(sumSplits(splits)).toBe(1200);
  });
});

describe('不変条件', () => {
  it('distribute は配った合計が必ず元の額に一致する', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        fc.array(fc.integer({ min: 0, max: 100_000 }), { minLength: 1, maxLength: 20 }),
        (amount, weights) => {
          const shares = distribute(amount, weights);
          expect(shares).toHaveLength(weights.length);
          expect(shares.reduce((sum, value) => sum + value, 0)).toBe(amount);
        },
      ),
    );
  });

  it('rebalance は内訳の合計を総額に合わせる', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.array(fc.integer({ min: 1, max: 500_000 }), { minLength: 1, maxLength: 15 }),
        (total, amounts) => {
          const splits = amounts.map((amount, index) => ({
            id: `s${index}`,
            amount,
            categoryId: 'food',
            origin: 'manual' as const,
          }));
          expect(isBalanced(rebalance(splits, total), total)).toBe(true);
        },
      ),
    );
  });

  it('レシートから作る内訳も総額に一致する', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 200_000 }),
        fc.array(
          fc.record({ name: fc.string({ minLength: 1, maxLength: 12 }), amount: fc.integer({ min: 1, max: 50_000 }) }),
          { minLength: 0, maxLength: 25 },
        ),
        (total, items) => {
          const receipt: Receipt = { ...CONBINI_RECEIPT, total, items };
          expect(sumSplits(splitsFromReceipt(receipt, total))).toBe(total);
        },
      ),
    );
  });

  it('内訳が空でも総額を持つ 1 行になる', () => {
    expect(rebalance([], 1200)).toEqual([{ id: 'split-1', amount: 1200, categoryId: 'uncategorized', origin: 'fallback' }]);
  });
});
