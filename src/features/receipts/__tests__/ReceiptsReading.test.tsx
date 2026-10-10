import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { api, type ReceiptDraft } from '../../../api/index';
import { StoreProvider } from '../../../api/store';
import { ReceiptsPage } from '../ReceiptsPage';

const upload = vi.hoisted(() => ({ progress: undefined as ((ratio: number) => void) | undefined, finish: () => {} }));

vi.mock('../../../api/remote', async (original) => ({
  ...(await original<typeof import('../../../api/remote')>()),
  uploadToS3: (_target: unknown, _file: Blob, onProgress?: (ratio: number) => void) =>
    new Promise<void>((resolve) => {
      upload.progress = onProgress;
      upload.finish = resolve;
    }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((ok, ng) => {
    resolve = ok;
    reject = ng;
  });
  return { promise, resolve, reject };
}

function pickPhoto(container: HTMLElement) {
  const input = container.querySelector<HTMLInputElement>('input[type="file"][capture]')!;
  const file = new File(['receipt'], 'receipt.jpg', { type: 'image/jpeg' });
  fireEvent.change(input, { target: { files: [file] } });
}

describe('レシートを読んでいるあいだ', () => {
  beforeEach(() => {
    // jsdom は object URL も scrollTo も持たない
    URL.createObjectURL = vi.fn(() => 'blob:receipt');
    URL.revokeObjectURL = vi.fn();
    window.scrollTo = vi.fn() as typeof window.scrollTo;
    vi.spyOn(api, 'requestUpload').mockResolvedValue({ key: 'receipts/a.jpg', uploadUrl: 'https://example.com/put' });
  });
  afterEach(() => vi.restoreAllMocks());

  it('送った割合、届いたこと、読んでいる段を順に見せる', async () => {
    const analysis = deferred<ReceiptDraft>();
    vi.spyOn(api, 'analyzeReceipt').mockReturnValue(analysis.promise);
    const { container } = render(
      <StoreProvider>
        <ReceiptsPage />
      </StoreProvider>,
    );
    pickPhoto(container);

    expect(await screen.findByText('0%')).toBeInTheDocument();
    expect(screen.getByAltText('読み取り中のレシート')).toHaveAttribute('src', 'blob:receipt');

    act(() => upload.progress?.(0.42));
    expect(screen.getByText('42%')).toBeInTheDocument();

    await act(async () => upload.finish());
    expect(screen.getByText('届きました')).toBeInTheDocument();
    expect(screen.getByText(/写真は届いています/)).toBeInTheDocument();
    expect(screen.getByText('文字を読む').closest('li')).toHaveTextContent('（実行中）');

    await act(async () =>
      analysis.resolve({ storeName: 'ローソン', date: '2026-10-01', total: 300, items: [{ name: 'おにぎり', amount: 300 }] }),
    );
    expect(await screen.findByDisplayValue('ローソン')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:receipt');
  });

  it('送れたあとに読み取りで落ちたら、写真は届いていると伝えて手入力に回す', async () => {
    vi.spyOn(api, 'analyzeReceipt').mockRejectedValue(new Error('OCR が落ちました'));
    const { container } = render(
      <StoreProvider>
        <ReceiptsPage />
      </StoreProvider>,
    );
    pickPhoto(container);
    await screen.findByText('0%');
    await act(async () => upload.finish());

    expect(await screen.findByText(/写真は届いていますが、読み取れませんでした/)).toBeInTheDocument();
    expect(screen.getByText('読み取り結果')).toBeInTheDocument();
  });
});
