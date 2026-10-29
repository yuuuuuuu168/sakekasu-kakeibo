import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { SEED_CATEGORIES, TRANSFER_ID, allRules, type CategoryRule, type Receipt, type Transaction } from '@kakeibo/core';
import type { Snapshot } from '../../../api/types';
import { ActionErrorProvider } from '../../../components/ActionErrorProvider';
import { useActionError } from '../../../lib/action';

/** App の上部の帯の代わり。useAction が拾った失敗を出す */
function ActionErrorBanner() {
  const error = useActionError();
  return error ? <p role="alert">{error.message}</p> : null;
}

const store = vi.hoisted(() => ({
  snapshot: { categories: [], rules: [], budgets: [], transactions: [], receipts: [], mappings: [], recurring: [] } as Snapshot,
  rules: [] as CategoryRule[],
  saveTransaction: vi.fn(async (_txn: Transaction) => undefined),
  saveTransactions: vi.fn(async (_txns: Transaction[]) => undefined),
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
  store.snapshot = { ...store.snapshot, categories: SEED_CATEGORIES, transactions, receipts: [] };
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

  it('組の両側に、内訳・紐付いたレシート・メモ・曜日つきの日付を出す', () => {
    const receipt: Receipt = {
      id: 'r1',
      storeName: 'セブン-イレブン 品川駅前店',
      date: '2026-09-01',
      total: 1200,
      items: [
        { name: 'おにぎり', amount: 300 },
        { name: 'ボールペン', amount: 900 },
      ],
      txnId: 'cash1',
      status: 'cash',
    };
    load([
      {
        ...CASH,
        splits: [
          { id: 'cash1-1', name: 'おにぎり', amount: 300, categoryId: 'food', origin: 'receipt' },
          { id: 'cash1-2', name: 'ボールペン', amount: 900, categoryId: 'daily', origin: 'receipt' },
        ],
      },
      { ...CARD, note: '会社の備品' },
    ]);
    store.snapshot = { ...store.snapshot, receipts: [receipt] };
    render(<TransactionsPage month="2026-09" filter="duplicates" />);

    const cash = within(screen.getByRole('list', { name: 'セブン-イレブン品川駅前店（現金）の内訳' }));
    expect(cash.getByText('おにぎり')).toBeInTheDocument();
    expect(cash.getByText('ボールペン')).toBeInTheDocument();
    expect(screen.getByText('セブン-イレブン 品川駅前店')).toBeInTheDocument();
    expect(screen.getByText('2 品')).toBeInTheDocument();
    expect(screen.getByText('メモ: 会社の備品')).toBeInTheDocument();
    expect(screen.getAllByText('2026/09/01（火）').length).toBeGreaterThan(0);
    expect(screen.getByText('2026/09/03（木）')).toBeInTheDocument();
  });

  it('内訳が長い明細は途中までにして、開けば全部出す', () => {
    const splits = Array.from({ length: 8 }, (_, i) => ({
      id: `cash1-${i}`,
      name: `品目${i}`,
      amount: 150,
      categoryId: 'food',
      origin: 'receipt' as const,
    }));
    load([{ ...CASH, splits }, CARD]);
    render(<TransactionsPage month="2026-09" filter="duplicates" />);

    expect(screen.getByText('品目4')).toBeInTheDocument();
    expect(screen.queryByText('品目5')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'ほか 3 行を見る' }));
    expect(screen.getByText('品目7')).toBeInTheDocument();
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

  it('消すのに失敗したら、黙らずに理由を出す', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    store.removeTransaction.mockRejectedValueOnce(new Error('API がエラーを返しました (500)'));
    render(
      <ActionErrorProvider>
        <ActionErrorBanner />
        <TransactionsPage month="2026-09" filter="duplicates" />
      </ActionErrorProvider>,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '2026-09-03 の セブン－イレブン品川（楽天カード）を消す' }));
    });

    expect(screen.getByRole('alert')).toHaveTextContent('API がエラーを返しました (500)');
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
    expect(screen.getByText('重複の可能性が高い組はありません')).toBeInTheDocument();
  });

  it('手がかりの少ない組は「念のための候補」に折りたたみ、まとめて重複ではないにできる', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const membership = (id: string, paymentId: string, label: string): Transaction => ({
      id,
      date: '2026-09-05',
      amount: 490,
      rawMerchant: label,
      merchant: label,
      source: 'manual',
      sourceLabel: '定期支払い',
      splits: [{ id: `${id}-1`, amount: 490, categoryId: 'food', origin: 'manual' }],
      needsDetail: false,
      recurring: { paymentId, month: '2026-09' },
    });
    load([CASH, CARD, membership('p1', 'rp-1', 'Towa Ch.'), membership('p2', 'rp-2', 'Iroha ch.')]);
    render(<TransactionsPage month="2026-09" filter="duplicates" />);

    expect(screen.getByText('重複の可能性 1 組')).toBeInTheDocument();
    expect(screen.getByText('念のための候補 1 組')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'まとめて重複ではない' }));
    });

    const saved = store.saveTransactions.mock.calls[0][0];
    expect(saved.map((txn) => [txn.id, txn.notDuplicateOf])).toEqual([
      ['p1', ['p2']],
      ['p2', ['p1']],
    ]);
    confirm.mockRestore();
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
