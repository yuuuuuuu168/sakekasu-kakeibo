import { describe, expect, it, vi } from 'vitest';
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
    // 長いレシートを分けて撮った写真をまとめて選べる。カメラの方は 1 枚ずつ
    expect(library?.multiple).toBe(true);
    expect(camera?.multiple).toBe(false);
  });

  it('支払い方法を選んで、そのまま明細として登録できる', async () => {
    // jsdom は scrollTo を持たない
    window.scrollTo = vi.fn() as typeof window.scrollTo;
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

    // 開くと、いま作った明細がつながって見える（明細が手元の状態に入っていること）
    fireEvent.click(screen.getByRole('button', { name: /タリーズコーヒー のレシートを開く/ }));
    expect(screen.getByText('このレシートから作った明細')).toBeInTheDocument();
    expect(screen.queryByText('明細が見つかりません。保存すると作り直します。')).not.toBeInTheDocument();
  });

  it('ドルのレシートは、レートで円に直して明細にする', async () => {
    window.scrollTo = vi.fn() as typeof window.scrollTo;
    render(
      <StoreProvider>
        <ReceiptsPage />
      </StoreProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: '手で入れる' }));
    fireEvent.change(screen.getByLabelText('店名'), { target: { value: 'Starbucks' } });
    fireEvent.change(screen.getByLabelText('通貨'), { target: { value: 'USD' } });
    fireEvent.change(screen.getByLabelText(/^合計/), { target: { value: '12.34' } });

    // 既定のレートが入り、円に直した額が見える
    expect(screen.getByLabelText(/^1 ドルの円/)).toHaveValue(150);
    expect(screen.getByText('約 ¥1,851')).toBeInTheDocument();

    // レートを消すと円に直せないので、明細にはできない
    fireEvent.change(screen.getByLabelText(/^1 ドルの円/), { target: { value: '' } });
    expect(screen.getByRole('button', { name: '現金払いとして登録' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/^1 ドルの円/), { target: { value: '155' } });
    fireEvent.click(screen.getByRole('button', { name: '現金払いとして登録' }));

    expect(await screen.findByText('現金払いとして明細に足しました。')).toBeInTheDocument();
    // 保存済みの一覧にはドルのまま出す
    expect(screen.getByText('$12.34')).toBeInTheDocument();
  });

  it('品目のカテゴリを選び直して保存すると、その品目を覚える', async () => {
    window.scrollTo = vi.fn() as typeof window.scrollTo;
    render(
      <StoreProvider>
        <ReceiptsPage />
      </StoreProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: '手で入れる' }));
    fireEvent.change(screen.getByLabelText('合計'), { target: { value: '510' } });
    fireEvent.click(screen.getByRole('button', { name: /品目を足す/ }));
    fireEvent.change(screen.getByLabelText('品目名'), { target: { value: 'アイスGコーヒー' } });
    fireEvent.change(screen.getByLabelText('金額'), { target: { value: '510' } });
    fireEvent.change(screen.getByLabelText('カテゴリ'), { target: { value: 'food-cafe' } });
    fireEvent.click(screen.getByRole('button', { name: 'レシートだけ保存' }));

    expect(await screen.findByText(/直したカテゴリを 1 品目ぶん覚えました/)).toBeInTheDocument();
  });
});
