import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SignOutButton } from '../SignOutButton';

describe('SignOutButton', () => {
  it('押すとサインアウトを呼ぶ', () => {
    const onSignOut = vi.fn(() => Promise.resolve());
    render(<SignOutButton onSignOut={onSignOut} />);

    fireEvent.click(screen.getByRole('button', { name: 'サインアウト' }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });
});
