import { describe, expect, it } from 'vitest';
import { DISCOUNT_ID, SEED_CATEGORIES } from '../categories';
import {
  emptySnapshot,
  normalizeSnapshot,
  removeReceiptFrom,
  removeTransactionFrom,
  replaceTransaction,
  reportInputFor,
  upsertBudget,
  upsertMapping,
  upsertReceipt,
  upsertTransactions,
} from '../snapshot';
import type { Receipt, Transaction } from '../types';

function txn(id: string, amount = 100): Transaction {
  return {
    id,
    date: '2026-09-01',
    amount,
    rawMerchant: 'ローソン',
    merchant: 'ローソン',
    source: 'credit',
    sourceLabel: 'クレジットカード',
    splits: [{ id: `${id}-1`, amount, categoryId: 'food', origin: 'rule' }],
    needsDetail: false,
  };
}

const RECEIPT: Receipt = { id: 'r1', storeName: 'ローソン', date: '2026-09-01', total: 100, items: [], status: 'pending' };

describe('normalizeSnapshot', () => {
  it('何も保存していなければ初期カテゴリから始める', () => {
    expect(normalizeSnapshot({})).toEqual(emptySnapshot());
  });

  it('カテゴリの行が空でも初期カテゴリから始める。値引きだけにはしない', () => {
    expect(normalizeSnapshot({ categories: [] }).categories).toEqual(SEED_CATEGORIES);
  });

  it('保存したカテゴリには、後から初期カテゴリに足した値引きを補う', () => {
    const categories = normalizeSnapshot({ categories: [{ id: 'food', label: '食費', order: 1 }] }).categories;
    expect(categories.map((category) => category.id)).toEqual(['food', DISCOUNT_ID]);
  });

  it('欠けている一覧は空で補い、ある一覧はそのまま使う', () => {
    const snapshot = normalizeSnapshot({ transactions: [txn('t1')] });
    expect(snapshot.transactions.map((item) => item.id)).toEqual(['t1']);
    expect(snapshot.receipts).toEqual([]);
    expect(snapshot.recurring).toEqual([]);
  });
});

describe('reportInputFor', () => {
  it('その月の上限だけを渡す', () => {
    const snapshot = {
      ...emptySnapshot(),
      budgets: [
        { month: '2026-08', limits: { food: 1 } },
        { month: '2026-09', limits: { food: 2 } },
      ],
    };
    expect(reportInputFor(snapshot, '2026-09').budget).toEqual({ month: '2026-09', limits: { food: 2 } });
    expect(reportInputFor(snapshot, '2026-10').budget).toBeUndefined();
  });
});

describe('保存したものの差し込み', () => {
  it('明細は id で上書きし、無ければ足す', () => {
    const snapshot = { ...emptySnapshot(), transactions: [txn('t1', 100)] };
    const next = upsertTransactions(snapshot, [txn('t1', 200), txn('t2')]);
    expect(next.transactions.map((item) => [item.id, item.amount])).toEqual([
      ['t1', 200],
      ['t2', 100],
    ]);
  });

  it('差し替えは既にある明細だけ。無い id は足さない', () => {
    const snapshot = { ...emptySnapshot(), transactions: [txn('t1', 100)] };
    expect(replaceTransaction(snapshot, txn('t1', 300)).transactions[0].amount).toBe(300);
    expect(replaceTransaction(snapshot, txn('t9')).transactions.map((item) => item.id)).toEqual(['t1']);
  });

  it('上限は月ごと、列の対応は取り込み元ごとに 1 つ', () => {
    let snapshot = upsertBudget(emptySnapshot(), { month: '2026-09', limits: { food: 1 } });
    snapshot = upsertBudget(snapshot, { month: '2026-09', limits: { food: 2 } });
    expect(snapshot.budgets).toEqual([{ month: '2026-09', limits: { food: 2 } }]);

    const mapping = { sourceId: 'credit', label: '楽天カード', source: 'credit' as const, mapping: { headerRowIndex: 0, date: 0, merchant: 1, amount: 2, sign: 'positive-expense' as const } };
    snapshot = upsertMapping(upsertMapping(snapshot, mapping), { ...mapping, label: 'カード' });
    expect(snapshot.mappings.map((item) => item.label)).toEqual(['カード']);
  });

  it('消すと一覧から外れる', () => {
    const snapshot = upsertReceipt({ ...emptySnapshot(), transactions: [txn('t1')] }, RECEIPT);
    expect(removeReceiptFrom(snapshot, 'r1').receipts).toEqual([]);
    expect(removeTransactionFrom(snapshot, 't1').transactions).toEqual([]);
  });
});
