/**
 * 利用者のデータ（明細・レシート・設定・レポート）を置くパーティション。
 *
 * 同じテーブルには OCR のジョブの行（`OCR#{sub}`、shared/ocr-job.ts）も同居している。
 * テーブルを Scan して利用者を数えるときは、この接頭辞で絞らないとジョブの行まで拾う。
 */
export const USER_PARTITION_PREFIX = 'USER#';

export const userPk = (sub: string) => `${USER_PARTITION_PREFIX}${sub}`;

export const isUserPartition = (pk: unknown): pk is string =>
  typeof pk === 'string' && pk.startsWith(USER_PARTITION_PREFIX);
