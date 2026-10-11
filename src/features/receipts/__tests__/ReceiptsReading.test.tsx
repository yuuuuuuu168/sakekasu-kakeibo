import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { api, type ReceiptDraft } from '../../../api/index';
import { StoreProvider } from '../../../api/store';
import { MAX_RECEIPT_PHOTOS } from '@kakeibo/core';
import { ReceiptsPage } from '../ReceiptsPage';

type Upload = { progress?: (ratio: number) => void; finish: () => void; file?: Blob };
/** progress と finish は最後に始まった送信のもの。all は始まった順の全部 */
const upload = vi.hoisted(() => ({ progress: undefined as Upload['progress'], finish: () => {}, all: [] as Upload[] }));

vi.mock('../../../api/remote', async (original) => ({
  ...(await original<typeof import('../../../api/remote')>()),
  uploadToS3: (_target: unknown, file: Blob, onProgress?: (ratio: number) => void) =>
    new Promise<void>((resolve) => {
      upload.progress = onProgress;
      upload.finish = resolve;
      upload.all.push({ progress: onProgress, finish: resolve, file });
    }),
}));

/** 送る前の縮小。既定は元のファイルのまま（jsdom に canvas が無いときと同じ）。テストごとに差し替える */
const shrink = vi.hoisted(() => ({ impl: async (file: File): Promise<Blob> => file }));
vi.mock('../shrinkPhoto', () => ({ shrinkPhoto: (file: File) => shrink.impl(file) }));

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

function pickFromLibrary(container: HTMLElement, files: File[]) {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]:not([capture])')!;
  fireEvent.change(input, { target: { files } });
}

const photo = (name: string, size: number) => new File(['x'.repeat(size)], name, { type: 'image/jpeg' });

describe('レシートを読んでいるあいだ', () => {
  beforeEach(() => {
    upload.all = [];
    shrink.impl = async (file) => file;
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

  it('分けて撮った写真は、まとめて送って 1 枚のレシートとして読み、写真を全部残す', async () => {
    let count = 0;
    vi.mocked(api.requestUpload).mockImplementation(async () => {
      count += 1;
      return { key: `receipts/u/${count}.jpg`, uploadUrl: `https://example.com/put/${count}` };
    });
    const analyze = vi.spyOn(api, 'analyzeReceipt').mockResolvedValue({
      storeName: 'イオン',
      date: '2026-10-01',
      total: 2000,
      items: [{ name: '牛乳', amount: 2000 }],
    });
    const save = vi.spyOn(api, 'putReceipt');
    const { container } = render(
      <StoreProvider>
        <ReceiptsPage />
      </StoreProvider>,
    );
    pickFromLibrary(container, [photo('top.jpg', 100), photo('bottom.jpg', 300)]);

    expect(await screen.findByAltText('読み取り中のレシート（1/2 枚目）')).toBeInTheDocument();
    expect(screen.getByAltText('読み取り中のレシート（2/2 枚目）')).toBeInTheDocument();
    expect(screen.getByText(/写真を 2 枚送っています/)).toBeInTheDocument();
    await vi.waitFor(() => expect(upload.all).toHaveLength(2));

    // 送った割合はバイト数で均す。小さい 1 枚目が送り終えても 25%
    act(() => upload.all[0].progress?.(1));
    expect(screen.getByText('25%')).toBeInTheDocument();
    await act(async () => upload.all[0].finish());
    expect(analyze).not.toHaveBeenCalled();

    await act(async () => upload.all[1].finish());
    expect(await screen.findByDisplayValue('イオン')).toBeInTheDocument();
    expect(analyze).toHaveBeenCalledWith({ keys: ['receipts/u/1.jpg', 'receipts/u/2.jpg'] });

    fireEvent.click(screen.getByRole('button', { name: 'レシートだけ保存' }));
    await vi.waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0]).toMatchObject({
      imageKey: 'receipts/u/1.jpg',
      imageKeys: ['receipts/u/1.jpg', 'receipts/u/2.jpg'],
    });
  });

  it('分けて撮った写真の一部だけ送れなかったら、届いた写真だけ付けて手入力に回す', async () => {
    let count = 0;
    vi.mocked(api.requestUpload).mockImplementation(async () => {
      count += 1;
      if (count === 2) throw new Error('圏外です');
      return { key: `receipts/u/${count}.jpg`, uploadUrl: `https://example.com/put/${count}` };
    });
    const analyze = vi.spyOn(api, 'analyzeReceipt');
    const save = vi.spyOn(api, 'putReceipt');
    const { container } = render(
      <StoreProvider>
        <ReceiptsPage />
      </StoreProvider>,
    );
    pickFromLibrary(container, [photo('top.jpg', 100), photo('bottom.jpg', 100)]);
    await vi.waitFor(() => expect(upload.all).toHaveLength(1));
    await act(async () => upload.all[0].finish());

    expect(await screen.findByText(/2 枚のうち 1 枚しか送れませんでした.*圏外です/)).toBeInTheDocument();
    expect(analyze).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('合計'), { target: { value: '800' } });
    fireEvent.click(screen.getByRole('button', { name: 'レシートだけ保存' }));
    await vi.waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0]).toMatchObject({ imageKey: 'receipts/u/1.jpg' });
    expect(save.mock.calls[0][0]).not.toHaveProperty('imageKeys');
  });

  it('1 枚のレシートとして読める枚数より多く選んだら、送らずに選び直してもらう', async () => {
    const { container } = render(
      <StoreProvider>
        <ReceiptsPage />
      </StoreProvider>,
    );
    pickFromLibrary(
      container,
      Array.from({ length: MAX_RECEIPT_PHOTOS + 1 }, (_, index) => photo(`${index}.jpg`, 10)),
    );

    expect(await screen.findByText(new RegExp(`${MAX_RECEIPT_PHOTOS} 枚までです`))).toBeInTheDocument();
    expect(api.requestUpload).not.toHaveBeenCalled();
  });

  it('縮めた JPEG を送る（元の写真ではなく）', async () => {
    const shrunk = new Blob(['small'], { type: 'image/jpeg' });
    shrink.impl = async () => shrunk;
    vi.spyOn(api, 'analyzeReceipt').mockReturnValue(new Promise(() => {}));
    const { container } = render(
      <StoreProvider>
        <ReceiptsPage />
      </StoreProvider>,
    );
    pickFromLibrary(container, [new File(['x'.repeat(5000)], 'receipt.png', { type: 'image/png' })]);

    await screen.findByText('0%');
    expect(api.requestUpload).toHaveBeenCalledWith('image/jpeg');
    expect(upload.all[0]!.file).toBe(shrunk);
  });

  it('読めない形式でも、縮めて JPEG にできれば送る（カメラの HEIC など）', async () => {
    shrink.impl = async () => new Blob(['small'], { type: 'image/jpeg' });
    vi.spyOn(api, 'analyzeReceipt').mockReturnValue(new Promise(() => {}));
    const { container } = render(
      <StoreProvider>
        <ReceiptsPage />
      </StoreProvider>,
    );
    pickFromLibrary(container, [new File(['heic'], 'IMG_0001.heic', { type: 'image/heic' })]);

    await screen.findByText('0%');
    expect(api.requestUpload).toHaveBeenCalledWith('image/jpeg');
    expect(screen.queryByText(/この形式の画像は読めません/)).not.toBeInTheDocument();
  });
});
