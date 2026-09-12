import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { SEED_CATEGORIES, type Transaction } from '@kakeibo/core';
import { SplitDialog } from '../SplitDialog';

const TXN: Transaction = {
  id: 't1',
  date: '2026-09-01',
  amount: 1200,
  rawMerchant: 'セブン－イレブン品川',
  merchant: 'セブンイレブン品川',
  source: 'credit',
  sourceLabel: '楽天カード',
  splits: [{ id: 's1', amount: 1200, categoryId: 'food', origin: 'rule' }],
  needsDetail: true,
};

describe('SplitDialog', () => {
  it('コンビニの 1 回の支払いを食費と日用品に割れる', async () => {
    const onSave = vi.fn(async (_transaction: Transaction) => undefined);
    render(<SplitDialog transaction={TXN} categories={SEED_CATEGORIES} onClose={() => undefined} onSave={onSave} />);

    fireEvent.click(screen.getByRole('button', { name: '行を足す' }));
    const amounts = screen.getAllByLabelText('金額');
    fireEvent.change(amounts[0], { target: { value: '800' } });
    fireEvent.change(amounts[1], { target: { value: '400' } });
    fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: 'daily' } });

    expect(screen.getByText('差額なし')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '保存する' }));
    });
    expect(onSave).toHaveBeenCalled();
    const saved = onSave.mock.calls[0][0];
    expect(saved.needsDetail).toBe(false);
    expect(saved.splits.map((split) => [split.categoryId, split.amount])).toEqual([
      ['food', 800],
      ['daily', 400],
    ]);
  });

  it('差額が残っていても合計は明細の金額に揃う', async () => {
    const onSave = vi.fn(async (_transaction: Transaction) => undefined);
    render(<SplitDialog transaction={TXN} categories={SEED_CATEGORIES} onClose={() => undefined} onSave={onSave} />);

    fireEvent.change(screen.getAllByLabelText('金額')[0], { target: { value: '500' } });
    expect(screen.getByText('差額 ¥700')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '保存する' }));
    });
    expect(onSave).toHaveBeenCalled();
    const saved = onSave.mock.calls[0][0];
    expect(saved.splits.reduce((sum, split) => sum + split.amount, 0)).toBe(1200);
  });
});
