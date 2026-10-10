import { describe, expect, it } from 'vitest';
import { refileDiscounts } from '../receipt/discount';
import { sumSplits } from '../receipt/split';
import type { Receipt, Split, Transaction } from '../types';

const RECEIPT: Receipt = {
  id: 'r1',
  storeName: 'イトーヨーカドー',
  date: '2026-09-01',
  total: 1300,
  status: 'matched',
  txnId: 't1',
  createdAt: '2026-09-01T10:00:00Z',
  items: [
    { name: 'ティッシュ', amount: 1000, categoryId: 'daily-consumables' },
    { name: 'おにぎり', amount: 500, categoryId: 'food-deli' },
    { name: 'クーポン値引', amount: -200, categoryId: 'uncategorized' },
  ],
};

function txn(splits: Split[], extra: Partial<Transaction> = {}): Transaction {
  return {
    id: 't1',
    date: '2026-09-01',
    amount: sumSplits(splits),
    rawMerchant: 'イトーヨーカドー',
    merchant: 'イトーヨーカドー',
    source: 'credit',
    sourceLabel: '楽天カード',
    splits,
    needsDetail: false,
    receiptId: 'r1',
    ...extra,
  };
}

const receiptSplit = (name: string, amount: number, categoryId: string, index: number): Split => ({
  id: `split-${index}`,
  name,
  amount,
  categoryId,
  origin: 'receipt',
});

describe('refileDiscounts', () => {
  it('行のまま別のカテゴリに入っている値引きを、値引きに付け替える', () => {
    const before = txn([
      receiptSplit('ティッシュ', 1000, 'daily-consumables', 1),
      receiptSplit('おにぎり', 500, 'food-deli', 2),
      receiptSplit('おにぎり 値引', -200, 'food-deli', 3),
    ]);
    const { transactions } = refileDiscounts([before], []);
    expect(transactions).toHaveLength(1);
    expect(transactions[0].splits.map((split) => [split.categoryId, split.amount])).toEqual([
      ['daily-consumables', 1000],
      ['food-deli', 500],
      ['discount', -200],
    ]);
  });

  it('品目に配られて消えた値引きは、レシートから内訳を組み直して値引きの行を立てる', () => {
    // 前の splitsFromReceipt はクーポン -200 を 1000:500 で配っていた
    const before = txn([receiptSplit('ティッシュ', 867, 'daily-consumables', 1), receiptSplit('おにぎり', 433, 'food-deli', 2)]);
    const { transactions, receipts } = refileDiscounts([before], [RECEIPT]);
    expect(receipts[0].items[2].categoryId).toBe('discount');
    expect(transactions[0].splits.map((split) => [split.name, split.categoryId, split.amount])).toEqual([
      ['ティッシュ', 'daily-consumables', 1000],
      ['おにぎり', 'food-deli', 500],
      ['クーポン値引', 'discount', -200],
    ]);
    expect(sumSplits(transactions[0].splits)).toBe(before.amount);
  });

  it('レシートを当てた後に人が直した内訳は、組み直さない', () => {
    const edited = txn([receiptSplit('ティッシュ', 867, 'daily', 1), receiptSplit('おにぎり', 433, 'food-deli', 2)]);
    expect(refileDiscounts([edited], [RECEIPT]).transactions).toEqual([]);
  });

  it('送料無料の相殺と、名前の無い負の行（返金など）には触らない', () => {
    const shipping = txn([
      receiptSplit('本', 1000, 'hobby-books', 1),
      receiptSplit('配送料', 200, 'fees-shipping', 2),
      receiptSplit('割引', -200, 'fees-shipping', 3),
    ]);
    const refund = txn([{ id: 'x', amount: -500, categoryId: 'food', origin: 'manual' }], { id: 't2', receiptId: undefined });
    expect(refileDiscounts([shipping, refund], []).transactions).toEqual([]);
  });

  it('付け替えた後はもう候補に出ない', () => {
    const before = txn([receiptSplit('ティッシュ', 867, 'daily-consumables', 1), receiptSplit('おにぎり', 433, 'food-deli', 2)]);
    const first = refileDiscounts([before], [RECEIPT]);
    const second = refileDiscounts(first.transactions, first.receipts);
    expect(second).toEqual({ transactions: [], receipts: [] });
  });

  it('値引きを含まないレシートの明細は出さない', () => {
    const plain: Receipt = { ...RECEIPT, items: RECEIPT.items.slice(0, 2), total: 1500 };
    const before = txn([receiptSplit('ティッシュ', 1000, 'daily-consumables', 1), receiptSplit('おにぎり', 500, 'food-deli', 2)]);
    expect(refileDiscounts([before], [plain])).toEqual({ transactions: [], receipts: [] });
  });
});
