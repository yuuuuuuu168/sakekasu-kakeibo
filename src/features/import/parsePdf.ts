import type { TextItem } from 'pdfjs-dist/types/src/display/api';

/**
 * pdfjs は 350KB ほどあり、PDF を落とした人しか要らない。
 * ここで動的に読み込んで、最初の表示に載せないようにしている。
 */
async function loadPdfjs() {
  const [pdfjs, worker] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  return pdfjs;
}

/** 1 行に「日付 … 店名 … 金額」が並んでいる形を拾う。明細の PDF はたいていこの形 */
const LINE = /^(\d{4}[/\-.]\d{1,2}[/\-.]\d{1,2}|\d{1,2}[/\-.]\d{1,2})\s+(.*?)\s+([\d,]{2,})\s*$/;

export type PdfParseResult = {
  rows: string[][];
  /** テキスト層が無い（画像として出力された）PDF。解析できない */
  imageOnly: boolean;
  pageCount: number;
};

/**
 * PDF のテキスト層から明細の行を起こす。
 * 同じ高さに並んだ文字を 1 行としてつなぎ、日付と金額を含む行だけを残す。
 * 画像として出力された PDF はテキストが取れないので、その旨を返して画面で断る。
 */
export async function parsePdfStatement(file: File): Promise<PdfParseResult> {
  const pdfjs = await loadPdfjs();
  const buffer = await file.arrayBuffer();
  const document = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
  const rows: string[][] = [];
  let textLength = 0;

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const lines = groupIntoLines(content.items.filter(isTextItem));
    for (const line of lines) {
      textLength += line.length;
      const matched = LINE.exec(line);
      if (matched) rows.push([matched[1], matched[2].trim(), matched[3]]);
    }
  }

  await document.destroy();
  return { rows, imageOnly: textLength < 40, pageCount: document.numPages };
}

function isTextItem(item: unknown): item is TextItem {
  return typeof (item as TextItem)?.str === 'string';
}

function groupIntoLines(items: TextItem[]): string[] {
  const buckets = new Map<number, { x: number; text: string }[]>();
  for (const item of items) {
    if (item.str.trim() === '') continue;
    // 同じ行でも y はわずかにずれるので 2pt 単位に丸めてまとめる
    const y = Math.round(item.transform[5] / 2) * 2;
    const bucket = buckets.get(y) ?? [];
    bucket.push({ x: item.transform[4], text: item.str });
    buckets.set(y, bucket);
  }

  return [...buckets.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([, bucket]) =>
      bucket
        .sort((a, b) => a.x - b.x)
        .map((part) => part.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    );
}
