import { DetectDocumentTextCommand, TextractClient, type Block } from '@aws-sdk/client-textract';

/**
 * 評価だけで使う、Textract（DetectDocumentText）で起こした文字を Claude への手がかりに足す読み方。
 * 本番の OCR（ocr-receipt）は使っていない。足して ocr.perfect が上がるかを測るためのもの。
 *
 * Textract は同じアカウントの AWS のサービスで、写真は AWS の外に出ない。
 * 起こした文字は Claude にだけ渡し、ログには行の数と時間だけを出す。
 */

/**
 * 1 ページ（写真 1 枚）あたりのドル。DetectDocumentText の一般価格（1,000 ページで 1.5 ドル）からの見積もりで、
 * 予算（maxUsd）を数えるのに使うだけ。請求は Cost Explorer の Textract が正しい。
 */
export const TEXTRACT_USD_PER_PAGE = 0.0015;

/** 同期の API が受け付けるのは JPEG と PNG だけ（WebP は読めない） */
const SUPPORTED = new Set(['image/jpeg', 'image/png']);

export function textractSupports(mediaType: string): boolean {
  return SUPPORTED.has(mediaType);
}

let client: TextractClient | undefined;

/** 写真 1 枚の印字を、Textract が返した順の行で返す */
export async function detectLines(bytes: Uint8Array): Promise<string[]> {
  client ??= new TextractClient({});
  const result = await client.send(new DetectDocumentTextCommand({ Document: { Bytes: bytes } }));
  return linesOf(result.Blocks ?? []);
}

export function linesOf(blocks: Block[]): string[] {
  return blocks.flatMap((block) => (block.BlockType === 'LINE' && block.Text ? [block.Text] : []));
}

/**
 * 本番の指示文の後ろに足す手がかり。写真と食い違ったら写真を正とさせる。
 * Textract の読み違いをそのまま写さないようにするため。
 */
export function textractHint(pages: string[][]): string {
  const body = pages
    .map((lines, index) => `<textract photo="${index + 1}">\n${lines.join('\n')}\n</textract>`)
    .join('\n');
  return `

参考。同じ写真を別の OCR（Amazon Textract）で読んだ文字を、写真ごとに上から並べたもの。
- 読み違い・行の順の入れ替わり・読み落としを含むことがある。写真と食い違うときは写真を正とすること
- 数字や文字がかすれて読みにくいときの手がかりに使う。ここにしか無い行を品目として足さないこと
${body}`;
}
