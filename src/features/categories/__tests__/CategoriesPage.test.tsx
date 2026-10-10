import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { TRANSFER_ID, UNCATEGORIZED_ID, type Category } from '@kakeibo/core';
import type { Snapshot } from '../../../api/types';

const store = vi.hoisted(() => ({
  snapshot: {
    categories: [] as Category[],
    rules: [],
    budgets: [],
    transactions: [],
    receipts: [],
    mappings: [],
    recurring: [],
  } as Snapshot,
  saveCategories: vi.fn(async (_categories: Category[]) => undefined),
  saveBudget: vi.fn(async () => undefined),
  saveTransactions: vi.fn(async () => undefined),
}));

vi.mock('../../../api/store', () => ({ useStore: () => store }));

const { CategoriesPage } = await import('../CategoriesPage');

/** 初期カテゴリから切り離した形。小カテゴリは食費の下に 1 つだけ置く */
const NESTED: Category[] = [
  { id: 'food', label: '食費', order: 1 },
  { id: 'eatout', label: '外食', order: 2 },
  { id: 'cafe', label: 'カフェ', order: 3 },
  { id: 'daily', label: '日用品', order: 4 },
  { id: TRANSFER_ID, label: '振替・チャージ', order: 90 },
  { id: UNCATEGORIZED_ID, label: '未分類', order: 99 },
  { id: 'rice', label: '米・パン', order: 101, parentId: 'food' },
];

beforeEach(() => {
  store.saveCategories.mockClear();
  store.snapshot = { ...store.snapshot, categories: NESTED };
});

describe('CategoriesPage', () => {
  it('小カテゴリを親のすぐ下に並べる', async () => {
    await act(async () => {
      render(<CategoriesPage />);
    });

    const names = screen.getAllByLabelText('カテゴリ名').map((input) => (input as HTMLInputElement).value);
    expect(names[names.indexOf('食費') + 1]).toBe('米・パン');
  });

  it('小カテゴリには上限を入れさせない', async () => {
    await act(async () => {
      render(<CategoriesPage />);
    });

    expect(screen.queryByLabelText('食費 の上限')).not.toBeNull();
    expect(screen.queryByLabelText('米・パン の上限')).toBeNull();
    expect(screen.getAllByText('小カテゴリ')).toHaveLength(1);
  });

  it('親を選んで足すと小カテゴリとして保存する', async () => {
    await act(async () => {
      render(<CategoriesPage />);
    });

    fireEvent.change(screen.getByPlaceholderText('コンビニ、ふるさと納税 など'), { target: { value: '惣菜' } });
    fireEvent.change(screen.getByLabelText('追加する先'), { target: { value: 'food' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '追加' }));
    });

    const saved = store.saveCategories.mock.calls[0][0];
    expect(saved.find((category) => category.label === '惣菜')).toMatchObject({ parentId: 'food' });
  });

  it('親を選ばなければ大カテゴリとして保存する', async () => {
    await act(async () => {
      render(<CategoriesPage />);
    });

    fireEvent.change(screen.getByPlaceholderText('コンビニ、ふるさと納税 など'), { target: { value: 'ふるさと納税' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '追加' }));
    });

    const saved = store.saveCategories.mock.calls[0][0];
    expect(saved.find((category) => category.label === 'ふるさと納税')?.parentId).toBeUndefined();
  });

  it('既にあるカテゴリを小カテゴリに移せる', async () => {
    await act(async () => {
      render(<CategoriesPage />);
    });

    await act(async () => {
      fireEvent.change(screen.getByLabelText('外食 の親カテゴリ'), { target: { value: 'food' } });
    });

    const saved = store.saveCategories.mock.calls[0][0];
    expect(saved.find((category) => category.id === 'eatout')).toMatchObject({ parentId: 'food' });
  });

  it('小カテゴリを大カテゴリに戻せる', async () => {
    await act(async () => {
      render(<CategoriesPage />);
    });

    await act(async () => {
      fireEvent.change(screen.getByLabelText('米・パン の親カテゴリ'), { target: { value: '' } });
    });

    const saved = store.saveCategories.mock.calls[0][0];
    expect(saved.find((category) => category.id === 'rice')).not.toHaveProperty('parentId');
  });

  it('小カテゴリの下に小カテゴリは作らせない', async () => {
    await act(async () => {
      render(<CategoriesPage />);
    });

    // 「米・パン」は既に小カテゴリなので、その中に入れる選択肢は出さない
    const options = [...(screen.getByLabelText('外食 の親カテゴリ') as HTMLSelectElement).options].map((option) => option.value);
    expect(options).toContain('food');
    expect(options).not.toContain('rice');
  });
});
