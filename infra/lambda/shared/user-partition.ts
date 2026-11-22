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

/**
 * 下書き登録（Muse、infra/lambda/mail-inbox）の重複の印と 1 日の呼び出しの数を置くパーティション（`MAILINBOX#{sub}`）。
 * 画面が読む保存データには混ぜない
 */
export const MAIL_INBOX_PARTITION_PREFIX = 'MAILINBOX#';

/**
 * Yahoo!メールの取得（infra/lambda/mail-relay）の進み具合（最後に送った UID など）を置くパーティション。
 * 利用者ごとではなく、取りに行くメールの口座ごとに 1 行（`MAILRELAY#yahoo`）
 */
export const MAIL_RELAY_PARTITION_PREFIX = 'MAILRELAY#';
