import { MAX_RECEIPT_PHOTOS } from '@kakeibo/core';

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
export const OCR_JOB_STALE_MS = 270_000;

export type OcrJobStatus = 'pending' | 'done' | 'failed';

/** api が ocr-receipt を非同期で呼ぶときの本文。keys は上から順（分けて撮った長いレシートなら複数） */
export type OcrJobRequest = { jobId: string; sub: string; keys: string[] };

/**
 * 読む写真のキーを取り出す。1 枚なら `key`、分けて撮った長いレシートなら `keys`（上から順）。
 * どのキーも呼び出した人が上げたものに限る。キーの組み立ては api の createUpload と揃えてある。
 *
 * api が受け付けるときと、ocr-receipt が読む前の 2 か所で通す。他人の画像を読む経路は二重に塞いでおく。
 */
export function parseKeys(
  body: Record<string, unknown>,
  sub: string,
): { keys: string[] } | { error: string; status: 400 | 403; keys?: string[] } {
  const keys = Array.isArray(body.keys)
    ? body.keys.filter((key): key is string => typeof key === 'string' && key !== '')
    : typeof body.key === 'string' && body.key !== ''
      ? [body.key]
      : [];
  if (keys.length === 0 || (Array.isArray(body.keys) && keys.length !== body.keys.length)) {
    return { error: '画像のキーが要ります', status: 400 };
  }
  if (keys.length > MAX_RECEIPT_PHOTOS) {
    return { error: `一度に読めるのは ${MAX_RECEIPT_PHOTOS} 枚までです`, status: 400 };
  }
  if (new Set(keys).size !== keys.length) return { error: '同じ写真が重なっています', status: 400 };
  const foreign = keys.filter((key) => !key.startsWith(`receipts/${sub}/`));
  if (foreign.length > 0) return { error: 'その画像は読めません', status: 403, keys: foreign };
  return { keys };
}
