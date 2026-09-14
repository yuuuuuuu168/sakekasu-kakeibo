import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { SEED_CATEGORIES, type Transaction } from '@kakeibo/core';
import type { Snapshot } from '../../../api/types';

const store = vi.hoisted(() => ({
  snapshot: { categories: [], rules: [], budgets: [], transactions: [], receipts: [], mappings: [] } as Snapshot,
  saveTransaction: vi.fn(async (_txn: Transaction) => undefined),
  removeTransaction: vi.fn(async (_id: string) => undefined),
  saveRules: vi.fn(async () => undefined),
}));

vi.mock('../../../api/store', () => ({ useStore: () => store }));

const { TransactionsPage } = await import('../TransactionsPage');

/** 現金として保存したレシートの明細と、後から取り込んだ同じ買い物のカード明細 */
const CASH: Transaction = {
  id: 'cash1',
  date: '2026-09-01',
  amount: 1200,
  rawMerchant: 'セブン-イレブン品川駅前店',
  merchant: 'セブンイレブン品川駅前店',
  source: 'cash',
  sourceLabel: '現金',
  splits: [{ id: 'cash1-1', amount: 1200, categoryId: 'food', origin: 'receipt' }],
  needsDetail: false,
  receiptId: 'r1',
};

const CARD: Transaction = {
  id: 'card1',
  date: '2026-09-03',
  amount: 1200,
  rawMerchant: 'セブン－イレブン品川',
  merchant: 'セブンイレブン品川',
  source: 'credit',
  sourceLabel: '楽天カード',
  splits: [{ id: 'card1-1', amount: 1200, categoryId: 'food', origin: 'rule' }],
  needsDetail: false,
};

function load(transactions: Transaction[]) {
  store.snapshot = { ...store.snapshot, categories: SEED_CATEGORIES, transactions };
}

describe('TransactionsPage の重複の絞り込み', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    load([CASH, CARD]);
  });

  it('現金レシートと取り込んだカード明細を組で出す', () => {
    render(<TransactionsPage month="2026-09" filter="duplicates" />);
    expect(screen.getByText('重複の可能性 1 組')).toBeInTheDocument();
    expect(screen.getByText('セブン-イレブン品川駅前店')).toBeInTheDocument();
    expect(screen.getByText('セブン－イレブン品川')).toBeInTheDocument();
    expect(screen.getByText(/取り込み元が違う/)).toBeInTheDocument();
  });

  it('組の片方を消せる', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<TransactionsPage month="2026-09" filter="duplicates" />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '2026-09-03 の セブン－イレブン品川（楽天カード）を消す' }));
    });

    expect(store.removeTransaction).toHaveBeenCalledWith('card1');
    confirm.mockRestore();
  });

  it('重複ではないと印を付けると、両側に相手の ID が入り、次からは出ない', async () => {
    const { rerender } = render(<TransactionsPage month="2026-09" filter="duplicates" />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '重複ではない' }));
    });

    const saved = store.saveTransaction.mock.calls.map(([txn]) => txn);
    expect(saved.map((txn) => [txn.id, txn.notDuplicateOf])).toEqual([
      ['cash1', ['card1']],
      ['card1', ['cash1']],
    ]);

    load(saved);
    rerender(<TransactionsPage month="2026-09" filter="duplicates" />);
    expect(screen.getByText('重複の可能性はありません')).toBeInTheDocument();
  });

  it('月をまたぐ組も、どちらかがその月なら出る', () => {
    load([{ ...CASH, date: '2026-08-31' }, CARD]);
    render(<TransactionsPage month="2026-09" filter="duplicates" />);
    expect(screen.getByText('重複の可能性 1 組')).toBeInTheDocument();
  });

  it('絞り込みが重複でなければ今までどおり明細を並べる', () => {
    render(<TransactionsPage month="2026-09" filter="all" />);
    expect(screen.getByText('2 件')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重複ではない' })).not.toBeInTheDocument();
  });
});
