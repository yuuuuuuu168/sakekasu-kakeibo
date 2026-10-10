import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SEED_CATEGORIES, buildMonthlyReport, type Receipt, type Transaction } from '@kakeibo/core';
import { StoreProvider } from '../../../api/store';
import { ReportPage } from '../ReportPage';

function txn(id: string, date: string, amount: number, rawMerchant: string): Transaction {
  return {
    id,
    date,
    amount,
    rawMerchant,
    merchant: rawMerchant,
    source: 'credit',
    sourceLabel: '楽天カード',
    splits: [{ id: `${id}-1`, amount, categoryId: 'food', origin: 'rule' }],
    needsDetail: false,
    importId: '1',
  };
}

const snapshot = {
  categories: SEED_CATEGORIES,
  rules: [],
  budgets: [],
  transactions: [] as Transaction[],
  receipts: [] as Receipt[],
  mappings: [],
  recurring: [],
};

const updateTransaction = vi.fn(async (_txn: Transaction) => undefined);

vi.mock('../../../api/index', () => ({
  api: {
    mode: 'local',
    loadSnapshot: async () => snapshot,
    updateTransaction: (transaction: Transaction) => updateTransaction(transaction),
    // 保存済みのレポートは月初に作ったもの。レシートはまだ無かった
    getReport: async (month: string) =>
      buildMonthlyReport({ month, transactions: snapshot.transactions, categories: SEED_CATEGORIES, receipts: [] }),
  },
}));

beforeEach(() => {
  updateTransaction.mockClear();
  snapshot.transactions = [txn('a', '2026-09-03', 1200, 'セブン-イレブン'), txn('b', '2026-09-10', 39_800, 'AMAZON.CO.JP')];
  snapshot.receipts = [];
});

/** 確かめのカード。同じ店名が「使った額の多い店」にも出るので、カードの中だけを見る */
function checkList(): HTMLElement {
  return screen.getByText('身に覚えが無ければ', { exact: false }).nextElementSibling as HTMLElement;
}

function renderPage() {
  render(
    <StoreProvider>
      <ReportPage month="2026-09" />
    </StoreProvider>,
  );
}

describe('ReportPage の身に覚えの確かめ', () => {
  it('レシートと突き合わない支払いを並べ、身に覚えありで外す', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('これ大丈夫？ 2 件')).toBeInTheDocument());

    fireEvent.click(screen.getAllByRole('button', { name: '身に覚えあり' })[1]);
    await waitFor(() => expect(screen.getByText('これ大丈夫？ 1 件')).toBeInTheDocument());
    expect(updateTransaction).toHaveBeenCalledWith(expect.objectContaining({ id: 'b', confirmed: true }));
    expect(within(checkList()).queryByText('AMAZON.CO.JP')).not.toBeInTheDocument();
    expect(within(checkList()).getByText('セブン-イレブン')).toBeInTheDocument();
  });

  it('レポートを作った後に撮ったレシートで裏付けられた分は出さない', async () => {
    snapshot.receipts = [{ id: 'r1', storeName: 'セブン-イレブン', date: '2026-09-03', total: 1200, items: [], status: 'pending' }];
    renderPage();
    await waitFor(() => expect(screen.getByText('これ大丈夫？ 1 件')).toBeInTheDocument());
    expect(within(checkList()).getByText('AMAZON.CO.JP')).toBeInTheDocument();
    expect(within(checkList()).queryByText('セブン-イレブン')).not.toBeInTheDocument();
  });
});
