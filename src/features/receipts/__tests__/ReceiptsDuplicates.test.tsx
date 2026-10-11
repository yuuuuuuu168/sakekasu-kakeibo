import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Receipt, Transaction } from '@kakeibo/core';
import { StoreProvider } from '../../../api/store';
import { ReceiptsPage } from '../ReceiptsPage';

const KEY = 'sakekasu-kakeibo.snapshot.v1';

/** 同じレシートを 2 回撮って、それぞれクレジットカード払いとして登録してしまった形 */
function receipt(id: string): Receipt {
  return {
    id,
    storeName: 'Amazon',
    date: '2026-09-02',
    total: 572,
    items: [{ name: '単三電池', amount: 572 }],
    status: 'cash',
    paidWith: 'credit',
  };
}

function created(receiptId: string): Transaction {
  return {
    id: `t-${receiptId}`,
    date: '2026-09-02',
    amount: 572,
    rawMerchant: 'Amazon',
    merchant: 'AMAZON',
    source: 'credit',
    sourceLabel: 'クレジットカード',
    splits: [{ id: `t-${receiptId}-1`, amount: 572, categoryId: 'daily', origin: 'receipt' }],
    needsDetail: false,
    receiptId,
  };
}

function seed() {
  window.localStorage.setItem(
    KEY,
    JSON.stringify({ receipts: [receipt('r1'), receipt('r2')], transactions: [created('r1'), created('r2')] }),
  );
}

function stored(): { receipts: Receipt[]; transactions: Transaction[] } {
  return JSON.parse(window.localStorage.getItem(KEY) ?? '{}');
}

function renderPage() {
  render(
    <StoreProvider>
      <ReceiptsPage />
    </StoreProvider>,
  );
}

describe('同じレシートかもしれない組', () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('品目が違えば別の会計として出さない', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ receipts: [receipt('r1'), { ...receipt('r2'), items: [{ name: 'キッチンペーパー', amount: 572 }] }] }),
    );
    renderPage();
    expect(await screen.findByText('保存済み 2 枚')).toBeInTheDocument();
    expect(screen.queryByText(/同じレシートかもしれない組/)).not.toBeInTheDocument();
  });

  it('別の買い物と答えると、両方残して二度と出さない', async () => {
    seed();
    renderPage();
    expect(await screen.findByText('同じレシートかもしれない組 1 件')).toBeInTheDocument();
    expect(screen.getAllByText('単三電池')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: '別の買い物（両方残す）' }));

    await waitFor(() => expect(screen.queryByText(/同じレシートかもしれない組/)).not.toBeInTheDocument());
    const saved = stored();
    expect(saved.receipts).toHaveLength(2);
    expect(saved.receipts.find((item) => item.id === 'r1')?.notDuplicateOf).toEqual(['r2']);
    expect(saved.receipts.find((item) => item.id === 'r2')?.notDuplicateOf).toEqual(['r1']);
    expect(saved.transactions).toHaveLength(2);
  });

  it('同じレシートと答えると、残さない方とそこから作った明細を消す', async () => {
    seed();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();
    expect(await screen.findByText('同じレシートかもしれない組 1 件')).toBeInTheDocument();

    // 1 つ目（r1）を残す
    fireEvent.click(screen.getAllByRole('button', { name: '同じレシート：こちらを残す' })[0]);

    await waitFor(() => expect(screen.queryByText(/同じレシートかもしれない組/)).not.toBeInTheDocument());
    const saved = stored();
    expect(saved.receipts.map((item) => item.id)).toEqual(['r1']);
    expect(saved.transactions.map((item) => item.id)).toEqual(['t-r1']);
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('このレシートから作った明細も一緒に消えます'));
  });
});
