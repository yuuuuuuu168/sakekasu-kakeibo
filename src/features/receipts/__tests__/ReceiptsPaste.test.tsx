import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { api } from '../../../api/index';
import { StoreProvider } from '../../../api/store';
import { ReceiptsPage } from '../ReceiptsPage';

/**
 * api は読み込んだ時点の mode で決まる（ローカルのまま）。画面の分岐だけ後から remote にして、
 * OCR が使える状態の貼り付けを見る
 */
const mockConfig = vi.hoisted(() => ({
  config: { mode: 'local' as 'local' | 'remote', apiUrl: '', userPoolId: '', userPoolClientId: '', authDomain: '' },
}));
vi.mock('../../../config', () => mockConfig);

vi.mock('../../../api/remote', async (original) => ({
  ...(await original<typeof import('../../../api/remote')>()),
  uploadToS3: async () => {},
}));
vi.mock('../shrinkPhoto', () => ({ shrinkPhoto: async (file: File) => file }));

function renderPage() {
  return render(
    <StoreProvider>
      <ReceiptsPage />
    </StoreProvider>,
  );
}

/** jsdom の paste には clipboardData が無いので、items だけ持つものを差し込む */
function paste(target: EventTarget, entries: { kind: 'file' | 'string'; type: string; file?: File }[]) {
  const clipboardData = {
    items: entries.map((entry) => ({ kind: entry.kind, type: entry.type, getAsFile: () => entry.file ?? null })),
  };
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: clipboardData });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

const image = () => new File(['png'], 'image.png', { type: 'image/png' });

describe('クリップボードの画像を貼り付けて読む', () => {
  beforeEach(() => {
    mockConfig.config.mode = 'remote';
    URL.createObjectURL = vi.fn(() => 'blob:receipt');
    URL.revokeObjectURL = vi.fn();
    window.scrollTo = vi.fn() as typeof window.scrollTo;
    vi.spyOn(api, 'requestUpload').mockResolvedValue({ key: 'receipts/a.png', uploadUrl: 'https://example.com/put' });
    vi.spyOn(api, 'analyzeReceipt').mockResolvedValue({
      storeName: 'ローソン',
      date: '2026-10-01',
      total: 300,
      items: [{ name: 'おにぎり', amount: 300 }],
    });
  });
  afterEach(() => {
    mockConfig.config.mode = 'local';
    vi.restoreAllMocks();
  });

  it('Ctrl+V で貼った画像を、選んだ写真と同じく読んで下書きにする', async () => {
    renderPage();
    const event = paste(document.body, [{ kind: 'file', type: 'image/png', file: image() }]);

    expect(event.defaultPrevented).toBe(true);
    expect(await screen.findByDisplayValue('ローソン')).toBeInTheDocument();
    expect(api.analyzeReceipt).toHaveBeenCalledWith({ key: 'receipts/a.png' });
  });

  it('文字だけの貼り付けは邪魔しない', () => {
    renderPage();
    const event = paste(document.body, [{ kind: 'string', type: 'text/plain' }]);

    expect(event.defaultPrevented).toBe(false);
    expect(api.requestUpload).not.toHaveBeenCalled();
  });

  it('ボタンからはクリップボードを読み、画像が無ければそう伝える', async () => {
    const read = vi.fn().mockResolvedValue([{ types: ['text/plain'], getType: vi.fn() }]);
    Object.defineProperty(navigator, 'clipboard', { value: { read }, configurable: true });
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: '貼り付け' }));
    expect(await screen.findByText(/クリップボードに画像がありません/)).toBeInTheDocument();

    read.mockResolvedValue([{ types: ['image/png'], getType: async () => new Blob(['png'], { type: 'image/png' }) }]);
    fireEvent.click(screen.getByRole('button', { name: '貼り付け' }));
    expect(await screen.findByDisplayValue('ローソン')).toBeInTheDocument();
  });

  it('クリップボードを読めなければ、キーで貼る方法を伝える', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { read: vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')) },
      configurable: true,
    });
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: '貼り付け' }));
    expect(await screen.findByText(/Ctrl\+V（Mac は ⌘V）を押して貼り付けて/)).toBeInTheDocument();
  });

  it('ローカルモードでは読まずに、OCR が使えないと伝える', () => {
    mockConfig.config.mode = 'local';
    renderPage();
    paste(document.body, [{ kind: 'file', type: 'image/png', file: image() }]);

    expect(screen.getAllByText(/ローカルモードでは OCR が使えません/).length).toBeGreaterThan(1);
    expect(api.requestUpload).not.toHaveBeenCalled();
  });
});
