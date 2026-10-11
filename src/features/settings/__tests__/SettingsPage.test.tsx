import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

// 中身の画面はそれぞれのテストで見ているので、ここでは開閉だけを見る
vi.mock('../../categories/CategoriesPage', () => ({ CategoriesPage: () => <p>カテゴリの中身</p> }));
vi.mock('../../recurring/RecurringPayments', () => ({ RecurringPayments: () => <p>定期の中身</p> }));
vi.mock('../../rules/LearnedRules', () => ({ LearnedRules: () => <p>ルールの中身</p> }));

const { SettingsPage } = await import('../SettingsPage');

describe('設定画面の開閉', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('最初は全部閉じていて、見出しを押すとその節だけ開く', () => {
    render(<SettingsPage />);
    expect(screen.getByText('カテゴリの中身')).not.toBeVisible();
    expect(screen.getByText('定期の中身')).not.toBeVisible();

    const heading = screen.getByRole('button', { name: /定期的な支払い/ });
    expect(heading).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(heading);

    expect(heading).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('定期の中身')).toBeVisible();
    expect(screen.getByText('カテゴリの中身')).not.toBeVisible();

    fireEvent.click(heading);
    expect(screen.getByText('定期の中身')).not.toBeVisible();
  });

  it('開いた節を覚えていて、次に開いたときもそのまま', () => {
    const { unmount } = render(<SettingsPage />);
    fireEvent.click(screen.getByRole('button', { name: /覚えたカテゴリ/ }));
    unmount();

    render(<SettingsPage />);
    expect(screen.getByText('ルールの中身')).toBeVisible();
    expect(screen.getByText('カテゴリの中身')).not.toBeVisible();
  });

  it('すべて開く・すべて閉じる', () => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'すべて開く' }));
    expect(screen.getByText('カテゴリの中身')).toBeVisible();
    expect(screen.getByText('定期の中身')).toBeVisible();
    expect(screen.getByText('ルールの中身')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'すべて閉じる' }));
    expect(screen.getByText('ルールの中身')).not.toBeVisible();
  });
});
