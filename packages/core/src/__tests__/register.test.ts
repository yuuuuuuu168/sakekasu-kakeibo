import { describe, expect, it } from 'vitest';
import { SEED_CATEGORIES } from '../categories';
import { linkedTransaction, receiptCategorySummary, transactionFromReceipt } from '../receipt/register';
import { sumSplits } from '../receipt/split';
import type { Receipt, Transaction } from '../types';

const RECEIPT: Receipt = {
  id: 'r-1',
  storeName: 'タリーズコーヒー',
  date: '2026-09-08',
  total: 820,
  items: [
    { name: 'アイスGコーヒー', amount: 510, categoryId: 'food-cafe' },
    { name: 'イングリッシュマフィンツナチーズ', amount: 410, categoryId: 'food-cafe' },
    { name: 'モーニングセット', amount: -100, categoryId: 'food-cafe' },
  ],
  status: 'cash',
  paidWith: 'suica',
};

describe('transactionFromReceipt', () => {
  it('支払い方法を取り込み元にして、レシートの合計で明細を作る', () => {
    const txn = transactionFromReceipt(RECEIPT, 'suica');
    expect(txn).toMatchObject({ date: '2026-09-08', amount: 820, source: 'suica', sourceLabel: 'Suica', receiptId: 'r-1' });
    expect(sumSplits(txn.splits)).toBe(820);
  });

  /* 直すたびに ID を作り直すと、前の明細が残って二重に数える */
  it('前に作った明細を渡すと、ID とメモを残して中身だけ差し替える', () => {
    const before: Transaction = { ...transactionFromReceipt(RECEIPT, 'cash'), note: '朝ごはん', notDuplicateOf: ['card-1'] };
    const after = transactionFromReceipt({ ...RECEIPT, date: '2026-09-09', total: 920 }, 'suica', before);
    expect(after.id).toBe(before.id);
    expect(after).toMatchObject({ date: '2026-09-09', amount: 920, source: 'suica', note: '朝ごはん', notDuplicateOf: ['card-1'] });
    expect(sumSplits(after.splits)).toBe(920);
  });
});

describe('linkedTransaction', () => {
  const made = transactionFromReceipt(RECEIPT, 'suica');
  const card: Transaction = { ...made, id: 'card-1', source: 'credit', receiptId: undefined };

  it('レシートから作った明細を receiptId で引く', () => {
    expect(linkedTransaction(RECEIPT, [card, made])?.id).toBe(made.id);
  });

  it('紐付けた明細は txnId で引く', () => {
    expect(linkedTransaction({ ...RECEIPT, status: 'matched', txnId: 'card-1' }, [card, made])?.id).toBe('card-1');
  });

  it('つながっている明細が無ければ undefined', () => {
    expect(linkedTransaction({ ...RECEIPT, id: 'r-2' }, [card, made])).toBeUndefined();
  });
});

describe('receiptCategorySummary', () => {
  const item = (categoryId: string) => ({ name: '品目', amount: 100, categoryId });

  it('同じカテゴリは 1 回だけ出す', () => {
    expect(receiptCategorySummary(RECEIPT, SEED_CATEGORIES)).toBe('カフェ');
  });

  it('3 つ以上は 2 つまで出して「ほか」を付ける', () => {
    const ids = SEED_CATEGORIES.filter((category) => !category.parentId).slice(0, 3).map((category) => category.id);
    const summary = receiptCategorySummary({ ...RECEIPT, items: ids.map(item) }, SEED_CATEGORIES);
    expect(summary.split('・')).toHaveLength(2);
    expect(summary).toMatch(/ ほか$/);
  });

  it('品目が無ければそう書く', () => {
    expect(receiptCategorySummary({ ...RECEIPT, items: [] }, SEED_CATEGORIES)).toBe('品目なし');
  });
});
