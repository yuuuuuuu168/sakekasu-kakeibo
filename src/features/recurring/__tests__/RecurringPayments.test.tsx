import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SEED_CATEGORIES, type RecurringPayment } from '@kakeibo/core';
import { StoreProvider } from '../../../api/store';
import { RecurringPayments } from '../RecurringPayments';

const IPHONE: RecurringPayment = {
  id: 'rp-iphone',
  label: 'iPhone 16 分割',
  amount: 6600,
  categoryId: 'telecom',
  dayOfMonth: 27,
  startMonth: '2026-04',
  totalCount: 24,
  totalAmount: 158_400,
};

const snapshot = {
  categories: SEED_CATEGORIES,
  rules: [],
  budgets: [],
  transactions: [],
  receipts: [],
  mappings: [],
  recurring: [] as RecurringPayment[],
};

const putRecurring = vi.fn(async (_payments: RecurringPayment[]) => undefined);

vi.mock('../../../api/index', () => ({
  api: {
    mode: 'local',
    loadSnapshot: async () => snapshot,
    putRecurring: (payments: RecurringPayment[]) => putRecurring(payments),
  },
}));

/**
 * スナップショットの読み込みは非同期なので、カードの見出しではなく中身が出るまで待つ。
 * 見出しは読み込み前から出ているため、そこで待つと空の状態を操作してしまう。
 */
async function renderPage(ready = 'まだ登録がありません') {
  render(
    <StoreProvider>
      <RecurringPayments />
    </StoreProvider>,
  );
  await waitFor(() => expect(screen.getByText(ready)).toBeInTheDocument());
}

beforeEach(() => {
  putRecurring.mockClear();
  snapshot.recurring = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('RecurringPayments', () => {
  it('歯車から定期支払いを登録できる', async () => {
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: '追加' }));
    fireEvent.change(screen.getByLabelText('名前'), { target: { value: 'Netflix' } });
    fireEvent.change(screen.getByLabelText('金額'), { target: { value: '1590' } });
    fireEvent.change(screen.getByLabelText('カテゴリ'), { target: { value: 'fees-membership' } });
    fireEvent.change(screen.getByLabelText('引き落とし日'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('初回の月'), { target: { value: '2026-01' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '保存する' }));
    });

    expect(putRecurring).toHaveBeenCalledTimes(1);
    expect(putRecurring.mock.calls[0][0]).toEqual([
      expect.objectContaining({
        label: 'Netflix',
        amount: 1590,
        categoryId: 'fees-membership',
        dayOfMonth: 5,
        startMonth: '2026-01',
        intervalMonths: 1,
      }),
    ]);
    // 終わりを決めていないものに回数や総額を入れない
    expect(putRecurring.mock.calls[0][0][0].totalCount).toBeUndefined();
    expect(putRecurring.mock.calls[0][0][0].totalAmount).toBeUndefined();
  });

  it('名前か金額が空なら保存させない', async () => {
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: '追加' }));
    expect(screen.getByRole('button', { name: '保存する' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('名前'), { target: { value: 'Netflix' } });
    expect(screen.getByRole('button', { name: '保存する' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('金額'), { target: { value: '1590' } });
    expect(screen.getByRole('button', { name: '保存する' })).toBeEnabled();
  });

  it('回数を入れたものは残り回数と残額が出る', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-14T09:00:00+09:00'));
    snapshot.recurring = [IPHONE];
    await renderPage('iPhone 16 分割');

    // 24 回のうち 5 回（4〜8 月）払い終えている
    expect(screen.getByText(/あと 19 回/)).toBeInTheDocument();
    expect(screen.getByText(/¥125,400/)).toBeInTheDocument();
    expect(screen.getByText(/2026-09-27/)).toBeInTheDocument();
  });

  it('追加の入力欄は登録済みの一覧より上に開く', async () => {
    snapshot.recurring = [IPHONE];
    await renderPage('iPhone 16 分割');

    fireEvent.click(screen.getByRole('button', { name: '追加' }));

    // 追加ボタンはカードの上にあるので、一覧の下まで送らないと入力欄が見えないのは困る
    const nameInput = screen.getByLabelText('名前');
    const firstRow = screen.getByText('iPhone 16 分割');
    expect(nameInput.compareDocumentPosition(firstRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('停止すると archived が立つ', async () => {
    snapshot.recurring = [IPHONE];
    await renderPage('iPhone 16 分割');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'iPhone 16 分割 を停止' }));
    });
    expect(putRecurring.mock.calls[0][0][0].archived).toBe(true);
  });

  it('編集すると同じ id のまま書き換わる', async () => {
    snapshot.recurring = [IPHONE];
    await renderPage('iPhone 16 分割');

    fireEvent.click(screen.getByRole('button', { name: 'iPhone 16 分割 を編集' }));
    fireEvent.change(screen.getByLabelText('金額'), { target: { value: '6700' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '保存する' }));
    });

    expect(putRecurring.mock.calls[0][0]).toHaveLength(1);
    expect(putRecurring.mock.calls[0][0][0]).toMatchObject({ id: 'rp-iphone', amount: 6700, totalCount: 24 });
  });
});
