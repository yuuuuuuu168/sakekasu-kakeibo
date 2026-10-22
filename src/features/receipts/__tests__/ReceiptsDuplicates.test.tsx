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

  it('保存済み一覧のゴミ箱でも、そのレシートから作った明細を一緒に消す', async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ receipts: [receipt('r1')], transactions: [created('r1')] }));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();
    expect(await screen.findByText('保存済み 1 枚')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '消す' }));

    await waitFor(() => expect(stored().receipts).toHaveLength(0));
    expect(stored().transactions).toHaveLength(0);
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('このレシートから作った明細も一緒に消えます'));
  });
});

describe('保存する前の警告', () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  /** 保存済みの r1 と同じ内容を手で入れ直す。読み取り結果と同じ下書きの欄に載る */
  async function enterSame(orderNumber?: string) {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ receipts: [{ ...receipt('r1'), orderNumber: '250-1234567-1234567' }], transactions: [created('r1')] }),
    );
    renderPage();
    expect(await screen.findByText('保存済み 1 枚')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '手で入れる' }));
    fireEvent.change(screen.getByLabelText('店名'), { target: { value: 'Amazon' } });
    fireEvent.change(screen.getByLabelText('日付'), { target: { value: '2026-09-04' } });
    fireEvent.change(screen.getByLabelText('合計'), { target: { value: '572' } });
    if (orderNumber !== undefined) fireEvent.change(screen.getByLabelText(/^注文番号/), { target: { value: orderNumber } });
  }

  it('保存済みと同じかもしれない下書きには、登録する前に警告を出す', async () => {
    await enterSame();
    expect(screen.getByText('保存済みのレシートと同じかもしれません')).toBeInTheDocument();
    expect(screen.getByText(/2日ずれ/)).toBeInTheDocument();
  });

  it('注文番号が同じなら、そう添える。違えば別の注文として出さない', async () => {
    await enterSame('２５０-1234567-1234567');
    expect(screen.getByText(/注文番号が同じ/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/^注文番号/), { target: { value: '250-7654321-7654321' } });
    expect(screen.queryByText('保存済みのレシートと同じかもしれません')).not.toBeInTheDocument();
  });

  it('別の買い物と答えると警告を消し、保存したレシートに印を残して下の組にも出さない', async () => {
    await enterSame();
    fireEvent.click(screen.getByRole('button', { name: '別の買い物' }));
    expect(screen.queryByText('保存済みのレシートと同じかもしれません')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'レシートだけ保存' }));
    expect(await screen.findByText('保存済み 2 枚')).toBeInTheDocument();
    expect(stored().receipts.find((item) => item.id !== 'r1')?.notDuplicateOf).toEqual(['r1']);
    expect(screen.queryByText(/同じレシートかもしれない組/)).not.toBeInTheDocument();
  });

  it('やめて保存済みを開くと、読み取った下書きは保存せずに保存済みを開く', async () => {
    window.scrollTo = vi.fn() as typeof window.scrollTo;
    await enterSame();
    fireEvent.click(screen.getByRole('button', { name: 'やめて保存済みを開く' }));

    expect(screen.getByText('レシートを直す')).toBeInTheDocument();
    expect(screen.getByLabelText('日付')).toHaveValue('2026-09-02');
    expect(screen.queryByText('保存済みのレシートと同じかもしれません')).not.toBeInTheDocument();
    expect(stored().receipts).toHaveLength(1);
  });
});
