import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { MailRelayFilter } from '@kakeibo/core';
import type { Snapshot } from '../../../api/types';

const store = vi.hoisted(() => ({
  snapshot: { categories: [], rules: [], budgets: [], transactions: [], receipts: [], mappings: [], recurring: [] } as Snapshot,
  saveMailRelayFilter: vi.fn(async (_filter: MailRelayFilter) => undefined),
}));

vi.mock('../../../api/store', () => ({ useStore: () => store }));

const { MailRelayFilterSettings } = await import('../MailRelayFilterSettings');

describe('メールの転送の条件', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.snapshot = { ...store.snapshot, mailRelayFilter: undefined };
  });

  it('条件がまだ無ければ空の欄で、全部を転送していると出し、保存は押せない', () => {
    render(<MailRelayFilterSettings />);
    expect(screen.getByLabelText(/差出人/)).toHaveValue('');
    expect(screen.getByLabelText(/件名に含む言葉/)).toHaveValue('');
    expect(screen.getByText('いまは全部を転送しています')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
  });

  it('1 行に 1 つを、そろえてから保存し、そろえた結果を欄に戻す', async () => {
    render(<MailRelayFilterSettings />);
    fireEvent.change(screen.getByLabelText(/差出人/), { target: { value: '@Amazon.co.jp\n\namazon.co.jp\norder@shop.example' } });
    fireEvent.change(screen.getByLabelText(/件名に含む言葉/), { target: { value: ' 注文 \n領収' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '保存' }));
    });
    expect(store.saveMailRelayFilter).toHaveBeenCalledWith({ senders: ['amazon.co.jp', 'order@shop.example'], subjectWords: ['注文', '領収'] });
    expect(screen.getByLabelText(/差出人/)).toHaveValue('amazon.co.jp\norder@shop.example');
    expect(screen.getByLabelText(/件名に含む言葉/)).toHaveValue('注文\n領収');
  });

  it('保存済みの条件を欄に出し、件数を見せる', () => {
    store.snapshot = { ...store.snapshot, mailRelayFilter: { senders: ['amazon.co.jp'], subjectWords: ['注文', '領収'] } };
    render(<MailRelayFilterSettings />);
    expect(screen.getByLabelText(/差出人/)).toHaveValue('amazon.co.jp');
    expect(screen.getByText('いまの条件: 差出人 1 件・件名 2 件')).toBeInTheDocument();
  });

  it('空にして保存すれば、全部を転送する条件に戻る', async () => {
    store.snapshot = { ...store.snapshot, mailRelayFilter: { senders: ['amazon.co.jp'], subjectWords: [] } };
    render(<MailRelayFilterSettings />);
    fireEvent.change(screen.getByLabelText(/差出人/), { target: { value: '' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '保存' }));
    });
    expect(store.saveMailRelayFilter).toHaveBeenCalledWith({ senders: [], subjectWords: [] });
  });
});
