import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SEED_CATEGORIES, transactionFromReceipt, type Receipt, type Transaction } from '@kakeibo/core';
import type { Snapshot } from '../../../api/types';

const store = vi.hoisted(() => ({
  snapshot: { categories: [], rules: [], budgets: [], transactions: [], receipts: [], mappings: [], recurring: [] } as Snapshot,
  saveReceipt: vi.fn(async (_receipt: Receipt) => undefined),
  removeReceipt: vi.fn(async (_id: string) => undefined),
  saveTransaction: vi.fn(async (_txn: Transaction) => undefined),
  saveTransactions: vi.fn(async (_txns: Transaction[]) => undefined),
}));

vi.mock('../../../api/store', () => ({ useStore: () => store }));

const { ReceiptsPage } = await import('../ReceiptsPage');

const TULLYS: Receipt = {
  id: 'r-1',
  storeName: 'タリーズコーヒー 横浜コネクトスクエア店',
  date: '2026-09-08',
  total: 820,
  items: [
    { name: 'アイスGコーヒー', amount: 510, categoryId: 'food-cafe' },
    { name: 'イングリッシュマフィンツナチーズ', amount: 410, categoryId: 'food-cafe' },
    { name: 'モーニングセット', amount: -100, categoryId: 'food-cafe' },
  ],
  status: 'cash',
  paidWith: 'suica',
  createdAt: '2026-10-10T14:39:00.000Z',
};
const MADE = { ...transactionFromReceipt(TULLYS, 'suica'), note: '朝ごはん' };

function load(receipts: Receipt[], transactions: Transaction[]) {
  store.snapshot = { ...store.snapshot, categories: SEED_CATEGORIES, receipts, transactions };
}

describe('保存済みのレシートを開いて直す', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // jsdom は scrollTo を持たない。開いたときに上の欄へ戻す動きはここでは見ない
    window.scrollTo = vi.fn() as typeof window.scrollTo;
    load([TULLYS], [MADE]);
  });

  it('一覧のカテゴリは重ねずに 1 回だけ出す', () => {
    render(<ReceiptsPage />);
    expect(screen.getByText('カフェ')).toBeInTheDocument();
    expect(screen.queryByText('カフェ・カフェ')).not.toBeInTheDocument();
  });

  it('開くと中身とつながった明細が見え、直すと明細も同じ ID のまま直る', async () => {
    render(<ReceiptsPage />);
    fireEvent.click(screen.getByRole('button', { name: /タリーズコーヒー 横浜コネクトスクエア店 のレシートを開く/ }));

    expect(screen.getByText('レシートを直す')).toBeInTheDocument();
    expect(screen.getByLabelText('店名')).toHaveValue('タリーズコーヒー 横浜コネクトスクエア店');
    expect(screen.getAllByLabelText('品目名').map((input) => (input as HTMLInputElement).value)).toEqual([
      'アイスGコーヒー',
      'イングリッシュマフィンツナチーズ',
      'モーニングセット',
    ]);
    expect(screen.getByText('このレシートから作った明細')).toBeInTheDocument();
    expect(screen.getByLabelText('支払い方法')).toHaveValue('suica');

    fireEvent.change(screen.getByLabelText('日付'), { target: { value: '2026-09-09' } });
    fireEvent.change(screen.getByLabelText('支払い方法'), { target: { value: 'cash' } });
    fireEvent.click(screen.getByRole('button', { name: '直した内容で保存' }));

    expect(await screen.findByText('レシートと明細を直しました。')).toBeInTheDocument();
    expect(store.saveReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'r-1', date: '2026-09-09', status: 'cash', paidWith: 'cash', createdAt: TULLYS.createdAt }),
    );
    expect(store.saveTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ id: MADE.id, date: '2026-09-09', source: 'cash', sourceLabel: '現金', note: '朝ごはん', receiptId: 'r-1' }),
    );
    expect(screen.queryByText('レシートを直す')).not.toBeInTheDocument();
  });

  it('紐付けた明細は金額を変えず、内訳だけ合わせ直す', async () => {
    const card: Transaction = { ...MADE, id: 'card-1', source: 'credit', sourceLabel: '楽天カード', amount: 820, receiptId: 'r-1' };
    load([{ ...TULLYS, status: 'matched', paidWith: undefined, txnId: 'card-1' }], [card]);
    render(<ReceiptsPage />);
    fireEvent.click(screen.getByRole('button', { name: /のレシートを開く/ }));

    expect(screen.getByText('紐付けた明細')).toBeInTheDocument();
    expect(screen.queryByLabelText('支払い方法')).not.toBeInTheDocument();

    fireEvent.change(screen.getAllByLabelText('品目名')[0], { target: { value: 'アイスコーヒー' } });
    fireEvent.click(screen.getByRole('button', { name: '直した内容で保存' }));

    expect(await screen.findByText('レシートを直し、紐付けた明細の内訳も合わせました。')).toBeInTheDocument();
    const saved = store.saveTransaction.mock.calls[0][0];
    expect(saved).toMatchObject({ id: 'card-1', amount: 820, source: 'credit' });
    expect(saved.splits.map((split) => split.name)).toContain('アイスコーヒー');
  });

  it('レシートから作った明細が消えていれば、直すときに足し直す', async () => {
    load([TULLYS], []);
    render(<ReceiptsPage />);
    fireEvent.click(screen.getByRole('button', { name: /のレシートを開く/ }));
    expect(screen.getByText('明細が見つかりません。保存すると作り直します。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '直した内容で保存' }));

    expect(await screen.findByText('レシートを直し、消えていた明細を作り直しました。')).toBeInTheDocument();
    expect(store.saveTransaction).not.toHaveBeenCalled();
    expect(store.saveTransactions).toHaveBeenCalledWith([expect.objectContaining({ source: 'suica', receiptId: 'r-1' })]);
  });
});
