import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { SEED_CATEGORIES, TRANSFER_ID, allRules, type CategoryRule, type Transaction } from '@kakeibo/core';
import type { Snapshot } from '../../../api/types';

const store = vi.hoisted(() => ({
  snapshot: { categories: [], rules: [], budgets: [], transactions: [], receipts: [], mappings: [], recurring: [] } as Snapshot,
  rules: [] as CategoryRule[],
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
  store.rules = allRules([]);
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

/** チャージのルールを足す前に取り込まれ、交通費のまま残っている Suica チャージ */
const STALE_CHARGE: Transaction = {
  id: 'old1',
  date: '2026-09-02',
  amount: 10000,
  rawMerchant: 'モバイルSuica',
  merchant: 'モバイルSUICA',
  source: 'credit',
  sourceLabel: 'ビューカード',
  splits: [{ id: 'old1-1', amount: 10000, categoryId: 'transport', origin: 'rule' }],
  needsDetail: false,
};

const FARE: Transaction = {
  id: 'fare1',
  date: '2026-09-03',
  amount: 640,
  rawMerchant: 'JR東日本 品川',
  merchant: 'JR東日本品川',
  source: 'credit',
  sourceLabel: 'ビューカード',
  splits: [{ id: 'fare1-1', amount: 640, categoryId: 'transport', origin: 'rule' }],
  needsDetail: false,
};

describe('TransactionsPage の振替の絞り込み', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    load([STALE_CHARGE, FARE]);
  });

  it('取りこぼしたチャージを名指しして一覧にも出す', () => {
    render(<TransactionsPage month="2026-09" filter={TRANSFER_ID} />);
    expect(screen.getByText(/チャージらしい明細が 1 件/)).toBeInTheDocument();
    expect(screen.getAllByText('チャージらしい')).toHaveLength(1);
    expect(screen.getByText('モバイルSuica')).toBeInTheDocument();
    // 実際に乗った分は候補にしない
    expect(screen.queryByText('JR東日本 品川')).not.toBeInTheDocument();
  });

  it('まとめて振替にすると、内訳が振替 1 行になる', async () => {
    render(<TransactionsPage month="2026-09" filter={TRANSFER_ID} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'まとめて振替にする' }));
    });

    const saved = store.saveTransaction.mock.calls.map(([txn]) => txn);
    expect(saved).toHaveLength(1);
    expect(saved[0].id).toBe('old1');
    expect(saved[0].splits).toEqual([{ id: 'old1-1', amount: 10000, categoryId: TRANSFER_ID, origin: 'manual' }]);
  });

  it('振替になった明細は集計外だと分かるようにする', () => {
    load([{ ...STALE_CHARGE, splits: [{ id: 'old1-1', amount: 10000, categoryId: TRANSFER_ID, origin: 'manual' }] }, FARE]);
    render(<TransactionsPage month="2026-09" filter={TRANSFER_ID} />);
    expect(screen.getByText('振替・集計外')).toBeInTheDocument();
    expect(screen.queryByText(/チャージらしい明細が/)).not.toBeInTheDocument();
  });
});

const AMAZON: Transaction = {
  id: 'amz1',
  date: '2026-09-05',
  amount: 3104,
  rawMerchant: 'AMAZON.CO.JP',
  merchant: 'AMAZONCOJP',
  source: 'credit',
  sourceLabel: '楽天カード',
  splits: [{ id: 'amz1-1', amount: 3104, categoryId: 'daily', origin: 'rule' }],
  needsDetail: true,
};

const RAMEN: Transaction = {
  id: 'ramen1',
  date: '2026-09-06',
  amount: 980,
  rawMerchant: 'ラーメン太郎 品川',
  merchant: 'ラーメン太郎品川',
  source: 'credit',
  sourceLabel: '楽天カード',
  splits: [{ id: 'ramen1-1', amount: 980, categoryId: 'food-eatout', origin: 'rule' }],
  needsDetail: false,
};

describe('TransactionsPage のカテゴリの付け替え', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Amazon のような混ざる店は、直してもルールを覚えない', async () => {
    load([AMAZON]);
    render(<TransactionsPage month="2026-09" filter="all" />);
    await act(async () => {
      fireEvent.change(screen.getByLabelText('カテゴリ'), { target: { value: 'work' } });
    });
    expect(store.saveTransaction).toHaveBeenCalled();
    expect(store.saveRules).not.toHaveBeenCalled();
  });

  it('普通の店は、直すと次から同じカテゴリになるよう覚える', async () => {
    load([RAMEN]);
    render(<TransactionsPage month="2026-09" filter="all" />);
    await act(async () => {
      fireEvent.change(screen.getByLabelText('カテゴリ'), { target: { value: 'social-dining' } });
    });
    expect(store.saveRules).toHaveBeenCalled();
  });
});

describe('TransactionsPage のカテゴリの絞り込み', () => {
  it('大カテゴリで絞ると、その下の小カテゴリの明細も出る', () => {
    load([RAMEN, AMAZON]);
    render(<TransactionsPage month="2026-09" filter="food" />);
    expect(screen.getByText('ラーメン太郎 品川')).toBeInTheDocument();
    expect(screen.queryByText('AMAZON.CO.JP')).not.toBeInTheDocument();
  });
});
