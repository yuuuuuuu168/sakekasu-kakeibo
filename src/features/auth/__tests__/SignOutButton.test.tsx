import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SignOutButton } from '../SignOutButton';

describe('SignOutButton', () => {
  it('押しただけではサインアウトせず、確かめてから呼ぶ', () => {
    const onSignOut = vi.fn(() => Promise.resolve());
    render(<SignOutButton onSignOut={onSignOut} />);

    fireEvent.click(screen.getByRole('button', { name: 'サインアウト' }));
    expect(onSignOut).not.toHaveBeenCalled();

    const dialog = screen.getByRole('dialog', { name: 'サインアウト' });
    fireEvent.click(dialog.querySelector('button.bg-accent') as HTMLButtonElement);
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it('やめるで閉じる', () => {
    const onSignOut = vi.fn(() => Promise.resolve());
    render(<SignOutButton onSignOut={onSignOut} />);

    fireEvent.click(screen.getByRole('button', { name: 'サインアウト' }));
    fireEvent.click(screen.getByRole('button', { name: 'やめる' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onSignOut).not.toHaveBeenCalled();
  });
});
