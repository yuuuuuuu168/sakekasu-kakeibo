import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { SEED_CATEGORIES, type RecurringPayment, type Transaction } from '@kakeibo/core';
import { StoreProvider, useStore } from '../store';

const NETFLIX: RecurringPayment = {
  id: 'rp-netflix',
  label: 'Netflix',
  amount: 1590,
  categoryId: 'fees-membership',
  dayOfMonth: 5,
  startMonth: '2026-01',
};

const snapshot = {
  categories: SEED_CATEGORIES,
  rules: [],
  budgets: [],
  transactions: [] as Transaction[],
  receipts: [],
  mappings: [],
  recurring: [] as RecurringPayment[],
};

const putTransactions = vi.fn(async (_transactions: Transaction[]) => undefined);
const deleteTransaction = vi.fn(async (_id: string) => undefined);
const putRecurring = vi.fn(async (_payments: RecurringPayment[]) => undefined);

vi.mock('../index', () => ({
  api: {
    mode: 'local',
    loadSnapshot: async () => snapshot,
    putTransactions: (transactions: Transaction[]) => putTransactions(transactions),
    deleteTransaction: (id: string) => deleteTransaction(id),
    putRecurring: (payments: RecurringPayment[]) => putRecurring(payments),
  },
}));

function Probe() {
  const { snapshot: current, loading } = useStore();
  if (loading) return null;
  return <p>{current.transactions.map((txn) => `${txn.date}:${txn.sourceLabel}`).join(',') || 'なし'}</p>;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 10, 12));
  putTransactions.mockClear();
  deleteTransaction.mockClear();
  putRecurring.mockClear();
  snapshot.transactions = [];
  snapshot.recurring = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('定期支払いの明細', () => {
  it('支払日を迎えた回を、開いたときに明細にする', async () => {
    snapshot.recurring = [{ ...NETFLIX, postedThrough: '2026-08' }];
    render(
      <StoreProvider>
        <Probe />
      </StoreProvider>,
    );

    await waitFor(() => expect(screen.getByText('2026-09-05:定期支払い,2026-10-05:定期支払い')).toBeInTheDocument());
    expect(putTransactions).toHaveBeenCalledTimes(1);
    expect(putRecurring.mock.calls[0]?.[0]).toEqual([expect.objectContaining({ id: 'rp-netflix', postedThrough: '2026-10' })]);
    expect(deleteTransaction).not.toHaveBeenCalled();
  });

  it('同じ回の明細を取り込んであれば、作った明細を消す', async () => {
    snapshot.recurring = [{ ...NETFLIX, postedThrough: '2026-10' }];
    snapshot.transactions = [
      {
        id: 'recurring-rp-netflix-2026-10',
        date: '2026-10-05',
        amount: 1590,
        rawMerchant: 'Netflix',
        merchant: 'Netflix',
        source: 'manual',
        sourceLabel: '定期支払い',
        splits: [{ id: 's1', amount: 1590, categoryId: 'fees-membership', origin: 'manual' }],
        needsDetail: false,
        recurring: { paymentId: 'rp-netflix', month: '2026-10' },
      },
      {
        id: 'card-1',
        date: '2026-10-06',
        amount: 1590,
        rawMerchant: 'NETFLIX.COM',
        merchant: 'NETFLIX.COM',
        source: 'credit',
        sourceLabel: '楽天カード',
        splits: [{ id: 's2', amount: 1590, categoryId: 'fees-membership', origin: 'rule' }],
        needsDetail: false,
      },
    ];
    render(
      <StoreProvider>
        <Probe />
      </StoreProvider>,
    );

    await waitFor(() => expect(screen.getByText('2026-10-06:楽天カード')).toBeInTheDocument());
    expect(deleteTransaction).toHaveBeenCalledWith('recurring-rp-netflix-2026-10');
    expect(putTransactions).not.toHaveBeenCalled();
    expect(putRecurring).not.toHaveBeenCalled();
  });
});
