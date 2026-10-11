/**
 * レシートの読み取りジョブ。api の Lambda が積み、ocr-receipt の Lambda が結果を書き込む。
 *
 * 読み取りは API Gateway の 30 秒の上限を超えうる（長いレシート、フォールバックで読み直すとき）。
 * そこで受け付けと読み取りを分け、画面は jobId で結果を聞きに来る。
 *
 * パーティションを明細（`USER#{sub}`）と分けているのは、スナップショットの読み込みに
 * ジョブの行を混ぜないため。ocr-receipt の権限もこの接頭辞の行だけに絞っている。
 */

/** ジョブの行を置くパーティションの接頭辞。IAM の LeadingKeys もこれで絞る */
export const OCR_JOB_PARTITION_PREFIX = 'OCR#';

export const ocrJobKey = (sub: string, jobId: string) => ({
  pk: `${OCR_JOB_PARTITION_PREFIX}${sub}`,
  sk: `JOB#${jobId}`,
});

/** ジョブの行は 1 日で TTL に消させる。結果は画面が受け取った時点で用済み */
export const OCR_JOB_TTL_SECONDS = 24 * 60 * 60;

/**
 * ここを過ぎても pending のままなら、読み取りの Lambda が落ちたものとみなす。
 * Lambda のタイムアウト（api-stack の OCR_TIMEOUT_SECONDS）より少し長く取る。
 */
export const OCR_JOB_STALE_MS = 150_000;

export type OcrJobStatus = 'pending' | 'done' | 'failed';

/** api が ocr-receipt を非同期で呼ぶときの本文 */
export type OcrJobRequest = { jobId: string; sub: string; key: string };

/** 自分が上げた画像だけを読ませる。キーの組み立ては api の createUpload と揃えてある */
export function ownsReceiptKey(sub: string, key: string): boolean {
  return key.startsWith(`receipts/${sub}/`);
}
