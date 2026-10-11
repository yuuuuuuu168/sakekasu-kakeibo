/**
 * 1 枚のレシートとして一緒に読める写真の数。長いレシートは 1 枚に収まらないので、
 * 上から分けて撮った写真をまとめて OCR に渡す。
 *
 * 画面（選べる枚数）と OCR の Lambda（受け付ける枚数）の両方がこれを読む。
 * 増やすと 1 回のモデルの呼び出しが重くなる。読み取りは非同期なので API Gateway の 30 秒には縛られないが、
 * OCR の Lambda のタイムアウト（infra/lib/api-stack.ts の OCR_TIMEOUT_SECONDS）には収めること。
 */
export const MAX_RECEIPT_PHOTOS = 4;

/**
 * レシートの写真として受け取る形式と、S3 に置くときの拡張子。OCR（Bedrock）が読めるのもこの 3 つ。
 *
 * 画面（選べる形式）と API（署名付き URL を出す形式）の両方がこれを読む。
 * `image/` で始まるもの全部を通すと SVG も置けてしまう。SVG は中にスクリプトを持てるので、
 * 保存した写真を画面に出すようになったときの穴になる。足すときはそこを確かめてから。
 *
 * ここで絞れるのは申告された形式だけで、中身のバイト列までは縛れない（画面で形式の分からない
 * ファイルは image/jpeg として送っている）。写真を画面に出すときは、配る側でも Content-Type を
 * この 3 つに固定し、X-Content-Type-Options: nosniff を付けて、ブラウザに中身を推測させないこと。
 */
export const RECEIPT_IMAGE_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const;

export type ReceiptImageType = keyof typeof RECEIPT_IMAGE_TYPES;

export function isReceiptImageType(contentType: string): contentType is ReceiptImageType {
  return Object.hasOwn(RECEIPT_IMAGE_TYPES, contentType);
}
