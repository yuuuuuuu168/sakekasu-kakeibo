import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { Snapshot } from '../../../api/types';

const store = vi.hoisted(() => ({
  snapshot: {
    categories: [],
    rules: [],
    budgets: [],
    transactions: [],
    receipts: [],
    mappings: [],
    recurring: [],
  } as Snapshot,
  rules: [],
  saveTransactions: vi.fn(async () => undefined),
  saveMapping: vi.fn(async () => undefined),
  saveRules: vi.fn(async () => undefined),
}));

vi.mock('../../../api/store', () => ({ useStore: () => store }));

const { ImportPage } = await import('../ImportPage');

/** カード会社の CSV によくある、見出しの手前に前置きの行がある形 */
const CSV = [
  '楽天カード ご利用明細',
  '会員番号,****-****-****-1234',
  '利用日,利用店名,利用金額',
  '2026/09/01,セブンイレブン,1200',
  '2026/09/02,スターバックス,650',
].join('\n');

describe('ImportPage', () => {
  it('列の選択肢には、0 行目ではなく見出しの行の名前を出す', async () => {
    render(<ImportPage />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File([CSV], 'statement.csv', { type: 'text/csv' });
    // jsdom の File は arrayBuffer を持たない
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode(CSV).buffer });

    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });

    const select = (await screen.findByLabelText('店名の列')) as HTMLSelectElement;
    const options = [...select.options].map((option) => option.textContent);
    expect(options).toContain('2 列目（利用店名）');
    expect(options.join()).not.toContain('会員番号');
  });
});
