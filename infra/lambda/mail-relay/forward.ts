import MailComposer from 'nodemailer/lib/mail-composer';
import type { AddressObject, ParsedMail } from 'mailparser';

/*
 * Muse Mail へ送るコピーの組み立て。AWS にも IMAP にも触らない純粋な処理。
 *
 * 元の差出人の名前では送らない。他人のドメインを名乗ると SPF / DKIM / DMARC で弾かれる（なりすまし）。
 * 家計簿のドメインから送り、本文の頭に元の差出人・宛先・日付・件名・Message-ID を書いて、
 * 本文と添付はそのまま載せる。Muse が下書き登録 API に渡す message_id は、この Message-ID の行の値。
 */

/** 添付の合計の上限。超えたら添付を全部外し、外したもののファイル名と大きさを本文に書く */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** 元のメールの大きさの上限。超えたら本文も取りに行かず、宛名の情報だけを送る（Lambda のメモリと時間を守る） */
export const MAX_SOURCE_BYTES = 30 * 1024 * 1024;

export type ForwardTarget = {
  /** 送り主（家計簿のドメイン） */
  from: string;
  /** Muse Mail のアドレス */
  to: string;
};

export type Dropped = { filename: string; size: number };

export type OriginalHeaders = {
  from: string;
  to: string;
  date: Date | undefined;
  subject: string;
  messageId: string | undefined;
};

export function headersOf(parsed: Pick<ParsedMail, 'from' | 'to' | 'date' | 'subject' | 'messageId'>): OriginalHeaders {
  return {
    from: addressText(parsed.from),
    to: addressText(parsed.to),
    date: parsed.date,
    subject: parsed.subject ?? '',
    messageId: parsed.messageId,
  };
}

function addressText(value: AddressObject | AddressObject[] | undefined): string {
  if (!value) return '';
  return (Array.isArray(value) ? value : [value]).map((address) => address.text).join(', ');
}

/** 本文の頭に付ける、元のメールの情報 */
export function headerBlock(original: OriginalHeaders, notes: string[] = []): string {
  return [
    '---------- 転送されたメッセージ ----------',
    `差出人: ${original.from || '（不明）'}`,
    `宛先: ${original.to || '（不明）'}`,
    `日付: ${original.date ? formatJst(original.date) : '（不明）'}`,
    `件名: ${original.subject || '（件名なし）'}`,
    `Message-ID: ${original.messageId ?? '（なし）'}`,
    ...notes,
    '',
    '',
  ].join('\n');
}

function formatJst(date: Date): string {
  const jst = new Date(date.getTime() + 9 * 3_600_000).toISOString();
  return `${jst.slice(0, 10)} ${jst.slice(11, 16)}（日本時間）`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** 添付を載せるか決める。合計が上限を超えたら全部外す（どれを残すかを選ばない。外したことだけを書く） */
export function pickAttachments(attachments: ParsedMail['attachments']): { kept: ParsedMail['attachments']; dropped: Dropped[] } {
  const total = attachments.reduce((sum, attachment) => sum + attachment.size, 0);
  if (total <= MAX_ATTACHMENT_BYTES) return { kept: attachments, dropped: [] };
  return {
    kept: [],
    dropped: attachments.map((attachment) => ({ filename: attachment.filename ?? '（名前なし）', size: attachment.size })),
  };
}

function droppedNotes(dropped: Dropped[]): string[] {
  if (dropped.length === 0) return [];
  return [
    `添付: 合計が ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB を超えたため外しました`,
    ...dropped.map((item) => `  - ${item.filename}（${formatSize(item.size)}）`),
  ];
}

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.ceil(bytes / 1024)}KB`;
}

/** 元のメールから、Muse Mail へ送るメールの生のバイト列を作る */
export async function buildForward(
  parsed: ParsedMail,
  target: ForwardTarget,
): Promise<{ raw: Buffer; attachments: number; dropped: Dropped[] }> {
  const original = headersOf(parsed);
  const { kept, dropped } = pickAttachments(parsed.attachments);
  const block = headerBlock(original, droppedNotes(dropped));

  const raw = await compose({
    from: target.from,
    to: target.to,
    subject: `Fwd: ${original.subject || '（件名なし）'}`,
    text: block + (parsed.text ?? ''),
    ...(parsed.html ? { html: `<pre>${escapeHtml(block)}</pre><hr>${parsed.html}` } : {}),
    attachments: kept.map((attachment) => ({
      filename: attachment.filename,
      content: attachment.content,
      contentType: attachment.contentType,
      // 本文に埋め込まれた画像は、HTML の cid: から引けるよう同じ ID で載せ直す
      ...(attachment.related && attachment.cid ? { cid: attachment.cid } : {}),
    })),
    headers: original.messageId ? { 'X-Original-Message-ID': original.messageId } : {},
  });
  return { raw, attachments: kept.length, dropped };
}

/** 大きすぎて中身を取りに行かなかったメール。宛名の情報（IMAP の ENVELOPE）だけを送る */
export async function buildOversizeNotice(original: OriginalHeaders, size: number, target: ForwardTarget): Promise<Buffer> {
  const block = headerBlock(original, [
    `本文と添付: メールが ${formatSize(size)} で、上限（${MAX_SOURCE_BYTES / 1024 / 1024}MB）を超えたため転送していません。Yahoo!メールで確認してください`,
  ]);
  return compose({
    from: target.from,
    to: target.to,
    subject: `Fwd: ${original.subject || '（件名なし）'}`,
    text: block,
    headers: original.messageId ? { 'X-Original-Message-ID': original.messageId } : {},
  });
}

function compose(options: ConstructorParameters<typeof MailComposer>[0]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    new MailComposer(options).compile().build((error, message) => (error ? reject(error) : resolve(message)));
  });
}
