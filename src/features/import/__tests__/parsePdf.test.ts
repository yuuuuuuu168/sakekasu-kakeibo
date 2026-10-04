import { beforeEach, describe, expect, it, vi } from 'vitest';

type Item = { str: string; transform: number[] };

const pdf = vi.hoisted(() => ({
  pages: [] as { str: string; transform: number[] }[][],
  failOpen: false,
  getDocument: vi.fn(),
  destroy: vi.fn(async () => {}),
  GlobalWorkerOptions: { workerSrc: '' },
}));

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: pdf.GlobalWorkerOptions,
  getDocument: pdf.getDocument,
}));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '/assets/pdf.worker.min.mjs' }));

import { parsePdfStatement } from '../parsePdf';

/** x, y の位置に文字を置いた pdfjs の TextItem を作る */
function text(str: string, x: number, y: number): Item {
  return { str, transform: [1, 0, 0, 1, x, y] };
}

/** jsdom の File は arrayBuffer() を持たないので、読む口だけの偽物を渡す */
function file(): File {
  return { arrayBuffer: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer } as unknown as File;
}

beforeEach(() => {
  pdf.pages = [];
  pdf.failOpen = false;
  pdf.destroy.mockClear();
  pdf.getDocument.mockReset();
  pdf.getDocument.mockImplementation(() => ({
    promise: pdf.failOpen
      ? Promise.reject(new Error('Invalid PDF structure.'))
      : Promise.resolve({
          numPages: pdf.pages.length,
          getPage: async (n: number) => ({
            getTextContent: async () => ({ items: pdf.pages[n - 1] }),
          }),
        }),
    destroy: pdf.destroy,
  }));
});

describe('parsePdfStatement', () => {
  it('同じ高さの文字を 1 行にまとめ、日付・店名・金額の行だけを拾う', async () => {
    pdf.pages = [
      [
        text('ご利用明細', 50, 760),
        // 並び順が崩れていても x で並べ直す。y のわずかなずれは同じ行とみなす
        text('1,200', 400, 700),
        text('2026/09/01', 50, 700),
        text('セブン-イレブン 渋谷店', 150, 700.6),
        text('2026/09/03', 50, 680),
        text('AMAZON.CO.JP', 150, 680),
        text('3,480', 400, 680),
      ],
      [text('9/10', 50, 700), text('PayPay ローソン', 150, 700), text('580', 400, 700)],
    ];

    const result = await parsePdfStatement(file());

    expect(result).toEqual({
      rows: [
        ['2026/09/01', 'セブン-イレブン 渋谷店', '1,200'],
        ['2026/09/03', 'AMAZON.CO.JP', '3,480'],
        ['9/10', 'PayPay ローソン', '580'],
      ],
      imageOnly: false,
      pageCount: 2,
    });
    expect(pdf.GlobalWorkerOptions.workerSrc).toBe('/assets/pdf.worker.min.mjs');
  });

  it('使わない機能を切って開き、読み終えたら読み込みタスクを片付ける', async () => {
    pdf.pages = [[text('2026/09/01', 50, 700)]];

    await parsePdfStatement(file());

    expect(pdf.getDocument).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.any(Uint8Array), enableXfa: false, disableFontFace: true }),
    );
    expect(pdf.destroy).toHaveBeenCalledTimes(1);
  });

  it('テキスト層がほとんど無い PDF は画像として出力されたものとして返す', async () => {
    pdf.pages = [[text(' ', 50, 700)], []];

    const result = await parsePdfStatement(file());

    expect(result).toEqual({ rows: [], imageOnly: true, pageCount: 2 });
  });

  it('壊れた PDF は例外を投げ、そのときも読み込みタスクを片付ける', async () => {
    pdf.failOpen = true;

    await expect(parsePdfStatement(file())).rejects.toThrow('Invalid PDF structure.');
    expect(pdf.destroy).toHaveBeenCalledTimes(1);
  });
});
