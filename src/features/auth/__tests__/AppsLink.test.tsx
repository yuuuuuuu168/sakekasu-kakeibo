import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AppsLink } from '../AppsLink';
import { APPS_URL } from '../signOutRedirect';

describe('AppsLink', () => {
  it('ポータルのアプリ一覧へのリンクを出す', () => {
    render(<AppsLink />);
    const link = screen.getByRole('link', { name: 'アプリ一覧' });
    expect(link).toHaveAttribute('href', 'https://sakekasu-builder.com/apps');
    expect(APPS_URL).toBe('https://sakekasu-builder.com/apps');
  });

  /* 同じタブで移る（新しいタブを開かない） */
  it('target を付けない', () => {
    render(<AppsLink />);
    expect(screen.getByRole('link', { name: 'アプリ一覧' })).not.toHaveAttribute('target');
  });
});
