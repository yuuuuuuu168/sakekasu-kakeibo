import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { StoreProvider } from '../../../api/store';
import { ReceiptsPage } from '../ReceiptsPage';

describe('ReceiptsPage', () => {
  it('撮る入力とは別に、カメラロールから選べる入力を持つ', () => {
    const { container } = render(
      <StoreProvider>
        <ReceiptsPage />
      </StoreProvider>,
    );
    const inputs = [...container.querySelectorAll<HTMLInputElement>('input[type="file"]')];
    expect(inputs).toHaveLength(2);

    const camera = inputs.find((input) => input.hasAttribute('capture'));
    expect(camera?.getAttribute('capture')).toBe('environment');

    // capture が付いているとスマホはカメラしか開かない
    const library = inputs.find((input) => !input.hasAttribute('capture'));
    expect(library?.accept).toBe('image/jpeg,image/png,image/webp');
  });

  it('支払い方法を選んで、そのまま明細として登録できる', async () => {
    render(
      <StoreProvider>
        <ReceiptsPage />
      </StoreProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: '手で入れる' }));
    fireEvent.change(screen.getByLabelText('店名'), { target: { value: 'タリーズコーヒー' } });
    fireEvent.change(screen.getByLabelText('合計'), { target: { value: '820' } });

    // レシートに支払いの印字が無ければ現金から始まる
    const method = screen.getByLabelText('支払い方法');
    expect([...within(method).getAllByRole('option')].map((option) => option.textContent)).toEqual([
      '現金',
      'PayPay',
      'クレジットカード',
      'Suica',
      '不明',
    ]);
    expect(screen.getByRole('button', { name: '現金払いとして登録' })).toBeInTheDocument();

    // 利用明細を取り込める支払い方法では、二重に数えないよう注意を出す
    fireEvent.change(method, { target: { value: 'credit' } });
    expect(screen.getByText(/両方だと二重に数えます/)).toBeInTheDocument();

    fireEvent.change(method, { target: { value: 'unknown' } });
    expect(screen.queryByText(/両方だと二重に数えます/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '支払い方法不明として登録' })).toBeInTheDocument();

    fireEvent.change(method, { target: { value: 'suica' } });
    fireEvent.click(screen.getByRole('button', { name: 'Suica払いとして登録' }));

    expect(await screen.findByText('Suica払いとして明細に足しました。')).toBeInTheDocument();
    expect(await screen.findByText('保存済み 1 枚')).toBeInTheDocument();
    expect(screen.getByText('Suica')).toBeInTheDocument();
  });
});
