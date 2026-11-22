import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SEED_CATEGORIES, type Receipt } from '@kakeibo/core';
import { SavedReceiptList } from '../SavedReceiptList';

const receipt = (overrides: Partial<Receipt>): Receipt => ({
  id: 'r-1',
  storeName: 'Amazon',
  date: '2026-11-22',
  total: 1398,
  items: [{ name: 'モノンズのアイマスク', amount: 1398, categoryId: 'uncategorized' }],
  status: 'pending',
  ...overrides,
});

describe('SavedReceiptList', () => {
  it('Muse が通販のメールから置いたレシートには「メールから」と添える', () => {
    render(
      <SavedReceiptList
        receipts={[receipt({ id: 'mail', source: 'mail' }), receipt({ id: 'photo', storeName: 'ローソン' })]}
        categories={SEED_CATEGORIES}
        onOpen={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(screen.getAllByText(/^メールから・/)).toHaveLength(1);
    expect(screen.getByRole('button', { name: /Amazon のレシートを開く/ })).toHaveTextContent('メールから');
    expect(screen.getByRole('button', { name: /ローソン のレシートを開く/ })).not.toHaveTextContent('メールから');
  });
});
