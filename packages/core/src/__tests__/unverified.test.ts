import { describe, expect, it } from 'vitest';
import { SEED_CATEGORIES } from '../categories';
import { buildMonthlyReport } from '../report';
import { confirmPayment, findUnverifiedPayments } from '../unverified';
import type { Receipt, RecurringPayment, Transaction } from '../types';

function txn(partial: Partial<Transaction> & { id: string; date: string; amount: number }): Transaction {
  return {
    rawMerchant: 'セブン-イレブン品川',
    merchant: 'セブンイレブン品川',
    source: 'credit',
    sourceLabel: '楽天カード',
    splits: [{ id: `${partial.id}-1`, amount: partial.amount, categoryId: 'food', origin: 'rule' }],
    needsDetail: false,
    importId: '1',
    ...partial,
  };
}

function receipt(partial: Partial<Receipt> & { id: string; date: string; total: number }): Receipt {
  return { storeName: 'セブン-イレブン品川駅前店', items: [], status: 'pending', ...partial };
}

function ids(input: { transactions: Transaction[]; receipts?: Receipt[]; recurring?: RecurringPayment[] }): string[] {
  return findUnverifiedPayments({ month: '2026-09', receipts: [], ...input }).map((payment) => payment.id);
}

describe('身に覚えの確かめ', () => {
  it('レシートの無いカードの支払いを拾う', () => {
    expect(ids({ transactions: [txn({ id: 'a', date: '2026-09-03', amount: 1200 })] })).toEqual(['a']);
  });

  it('同じ額で利用日が同じレシートがあれば外す', () => {
    const transactions = [txn({ id: 'a', date: '2026-09-03', amount: 1200 })];
    expect(ids({ transactions, receipts: [receipt({ id: 'r1', date: '2026-09-03', total: 1200 })] })).toEqual([]);
  });

  it('利用日の開きは 1 日まで。計上日のずれの 4 日までは広げない', () => {
    const transactions = [txn({ id: 'a', date: '2026-09-03', amount: 1200 })];
    expect(ids({ transactions, receipts: [receipt({ id: 'r1', date: '2026-09-02', total: 1200 })] })).toEqual([]);
    expect(ids({ transactions, receipts: [receipt({ id: 'r1', date: '2026-09-01', total: 1200 })] })).toEqual(['a']);
  });

  it('金額が違えば裏付けにならない', () => {
    const transactions = [txn({ id: 'a', date: '2026-09-03', amount: 1200 })];
    expect(ids({ transactions, receipts: [receipt({ id: 'r1', date: '2026-09-03', total: 1201 })] })).toEqual(['a']);
  });

  it('1 枚のレシートは 1 件の明細にしか使わない', () => {
    const transactions = [txn({ id: 'a', date: '2026-09-03', amount: 1200 }), txn({ id: 'b', date: '2026-09-03', amount: 1200, rawMerchant: '不明な店' })];
    expect(ids({ transactions, receipts: [receipt({ id: 'r1', date: '2026-09-03', total: 1200 })] })).toEqual(['b']);
  });

  it('レシートからカード払いで作った明細を残したままでも、取り込んだ明細はレシートで裏付けられる', () => {
    const fromReceipt = txn({ id: 'own', date: '2026-09-03', amount: 1200, receiptId: 'r1', importId: undefined });
    const imported = txn({ id: 'a', date: '2026-09-03', amount: 1200 });
    const receipts = [receipt({ id: 'r1', date: '2026-09-03', total: 1200, status: 'cash', paidWith: 'credit', txnId: undefined })];
    expect(ids({ transactions: [fromReceipt, imported], receipts })).toEqual([]);
  });

  it('現金払いのレシートはカードの支払いを裏付けない', () => {
    const transactions = [txn({ id: 'a', date: '2026-09-03', amount: 1200 })];
    const cash = receipt({ id: 'r1', date: '2026-09-03', total: 1200, status: 'cash', paidWith: 'cash' });
    const legacy = receipt({ id: 'r2', date: '2026-09-03', total: 1200, status: 'cash' });
    expect(ids({ transactions, receipts: [cash, legacy] })).toEqual(['a']);
    const unknown = receipt({ id: 'r3', date: '2026-09-03', total: 1200, status: 'cash', paidWith: 'unknown' });
    expect(ids({ transactions, receipts: [unknown] })).toEqual([]);
  });

  it('捨てたレシートと、別の明細に紐付いたレシートは使わない', () => {
    const transactions = [txn({ id: 'a', date: '2026-09-03', amount: 1200 })];
    const receipts = [
      receipt({ id: 'r1', date: '2026-09-03', total: 1200, status: 'discarded' }),
      receipt({ id: 'r2', date: '2026-09-03', total: 1200, status: 'matched', txnId: 'other' }),
    ];
    expect(ids({ transactions, receipts })).toEqual(['a']);
  });

  it('レシートに紐付いた明細、身に覚えありと言った明細は外す', () => {
    const transactions = [
      txn({ id: 'a', date: '2026-09-03', amount: 1200, receiptId: 'r1' }),
      confirmPayment(txn({ id: 'b', date: '2026-09-04', amount: 800 })),
    ];
    expect(ids({ transactions })).toEqual([]);
  });

  it('現金・Suica・返金・他の月は相手にしない', () => {
    const transactions = [
      txn({ id: 'cash', date: '2026-09-03', amount: 500, source: 'cash' }),
      txn({ id: 'suica', date: '2026-09-03', amount: 500, source: 'suica' }),
      txn({ id: 'refund', date: '2026-09-03', amount: -500 }),
      txn({ id: 'august', date: '2026-08-31', amount: 500 }),
      txn({ id: 'paypay', date: '2026-09-05', amount: 500, source: 'paypay', sourceLabel: 'PayPay' }),
    ];
    expect(ids({ transactions })).toEqual(['paypay']);
  });

  it('登録した定期支払いと突き合った明細は外す', () => {
    const recurring: RecurringPayment[] = [
      { id: 'n', label: 'Netflix', amount: 1490, categoryId: 'hobby', dayOfMonth: 15, startMonth: '2026-01', merchantPattern: 'NETFLIX' },
    ];
    const transactions = [txn({ id: 'a', date: '2026-09-15', amount: 1490, rawMerchant: 'NETFLIX.COM', merchant: 'NETFLIX.COM' })];
    expect(ids({ transactions })).toEqual(['a']);
    expect(ids({ transactions, recurring })).toEqual([]);
  });

  it('月次レポートに載せ、叱りの段階は変えずに 1 行足す', () => {
    const transactions = [txn({ id: 'a', date: '2026-09-03', amount: 1200 })];
    const base = { month: '2026-09', transactions, categories: SEED_CATEGORIES, generatedAt: '2026-10-01T00:00:00Z' };
    const withReceipts = buildMonthlyReport({ ...base, receipts: [] });
    expect(withReceipts.unverified?.map((payment) => payment.id)).toEqual(['a']);
    expect(withReceipts.scolding.lines.at(-1)).toContain('1 件');

    const without = buildMonthlyReport(base);
    expect(without.unverified).toEqual([]);
    expect(without.scolding.level).toBe(withReceipts.scolding.level);
  });
});
