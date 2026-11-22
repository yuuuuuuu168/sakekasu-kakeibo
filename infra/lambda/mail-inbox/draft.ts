import { classifyItem, normalizeOrderNumber, type Receipt, type ReceiptItem } from '@kakeibo/core';

/*
 * 下書き登録 API の本文の検査と、レシートへの組み立て。AWS にも環境変数にも触らない純粋な処理。
 * 本文の形は docs/mail-inbox.md の「リクエスト」にある（Muse と取り決めたもの）。
 */

/** 1 件の金額の上限（円）。メールに書かれた内容で動くので、桁違いの値で集計が壊れないよう低めに置く */
export const MAIL_MAX_AMOUNT = 30_000;
/** 1 件の品目の上限 */
export const MAIL_MAX_ITEMS = 50;
const MAX_TEXT_LENGTH = 200;
const MAX_ORDER_NUMBER_LENGTH = 100;
const MAX_MESSAGE_ID_LENGTH = 500;

export type MailDraft = {
  /** YYYY-MM-DD */
  date: string;
  store: string;
  title: string;
  amount: number;
  orderNumber: string | undefined;
  messageId: string;
  items: { name: string; amount: number }[];
};

export type FieldError = { field: string; message: string };

export type ParsedDraft = { ok: true; draft: MailDraft } | { ok: false; details: FieldError[] };

/**
 * 本文を検査する。1 つでも合わなければ、合わない項目を全部並べて返す（Muse が一度で直せるように）。
 * `category` は受け取っても読まない。カテゴリはこちらの基準（ルール・Jev・キーワード表）で決める
 */
export function parseMailDraft(body: unknown): ParsedDraft {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, details: [{ field: 'body', message: 'JSON のオブジェクトで送ってください' }] };
  }
  const value = body as Record<string, unknown>;
  const details: FieldError[] = [];

  const date = value.date;
  if (typeof date !== 'string' || !isRealDate(date)) {
    details.push({ field: 'date', message: '実在する日付を YYYY-MM-DD で入力してください' });
  }

  const store = text(value.store);
  if (store === undefined) details.push({ field: 'store', message: '空でない文字列で入力してください' });
  else if (store.length > MAX_TEXT_LENGTH) details.push({ field: 'store', message: `${MAX_TEXT_LENGTH} 文字以内で入力してください` });

  const title = text(value.title);
  if (title === undefined) details.push({ field: 'title', message: '空でない文字列で入力してください' });
  else if (title.length > MAX_TEXT_LENGTH) details.push({ field: 'title', message: `${MAX_TEXT_LENGTH} 文字以内で入力してください` });

  const amount = value.amount;
  const amountOk = Number.isSafeInteger(amount) && (amount as number) >= 1 && (amount as number) <= MAIL_MAX_AMOUNT;
  if (!amountOk) {
    details.push({ field: 'amount', message: `1以上${MAIL_MAX_AMOUNT}以下の整数で入力してください` });
  }

  // 必須だが null は許す（注文番号の無いメール）。項目そのものが無いのは送り忘れとして弾く
  let orderNumber: string | undefined;
  if (!('order_number' in value)) {
    details.push({ field: 'order_number', message: '注文番号か null を入れてください' });
  } else if (value.order_number !== null) {
    const raw = text(value.order_number);
    if (raw === undefined) details.push({ field: 'order_number', message: '空でない文字列か null で入力してください' });
    else if (raw.length > MAX_ORDER_NUMBER_LENGTH) {
      details.push({ field: 'order_number', message: `${MAX_ORDER_NUMBER_LENGTH} 文字以内で入力してください` });
    } else {
      // 画面で写しから読んだ注文番号と同じ規則でそろえる（全角・ダッシュの揺れ）。数字の無いものは注文番号として扱わない
      orderNumber = normalizeOrderNumber(raw);
    }
  }

  if (value.source !== 'mail') details.push({ field: 'source', message: '"mail" を入れてください' });

  const messageId = text(value.message_id);
  if (messageId === undefined) details.push({ field: 'message_id', message: '元のメールの Message-ID を入れてください' });
  else if (messageId.length > MAX_MESSAGE_ID_LENGTH) {
    details.push({ field: 'message_id', message: `${MAX_MESSAGE_ID_LENGTH} 文字以内で入力してください` });
  }

  const items = parseItems(value.items, details);
  if (items && amountOk) {
    const sum = items.reduce((total, item) => total + item.amount, 0);
    if (sum !== amount) {
      details.push({ field: 'items', message: `品目の金額の合計（${sum}）が amount（${amount as number}）と一致しません` });
    }
  }

  if (details.length > 0) return { ok: false, details };
  return {
    ok: true,
    draft: {
      date: date as string,
      store: store!,
      title: title!,
      amount: amount as number,
      orderNumber,
      messageId: messageId!,
      // 品目の一覧が無いメールは、内容と金額で 1 品目にする
      items: items ?? [{ name: title!, amount: amount as number }],
    },
  };
}

/** 無い・null なら undefined。あるのに形が違えば details に積んで undefined */
function parseItems(raw: unknown, details: FieldError[]): MailDraft['items'] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAIL_MAX_ITEMS) {
    details.push({ field: 'items', message: `1〜${MAIL_MAX_ITEMS} 行の配列か null で入力してください` });
    return undefined;
  }
  const items: MailDraft['items'] = [];
  let broken = false;
  raw.forEach((entry: unknown, index) => {
    const row = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
    const name = text(row.name);
    if (name === undefined || name.length > MAX_TEXT_LENGTH) {
      details.push({ field: `items[${index}].name`, message: `${MAX_TEXT_LENGTH} 文字以内の空でない文字列で入力してください` });
      broken = true;
    }
    // 割引・ポイント利用は負の数で来る
    if (!Number.isSafeInteger(row.amount)) {
      details.push({ field: `items[${index}].amount`, message: '整数で入力してください（割引は負の数）' });
      broken = true;
    }
    if (!broken) items.push({ name: name!, amount: row.amount as number });
  });
  return broken ? undefined : items;
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function isRealDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * 下書きをレシートにする。明細とはまだ結び付けない（status は pending）。
 * クレジットカードで払った前提なので、カードの明細を取り込むと、いつものマッチで結び付く。
 * ここで当てるカテゴリはキーワード表まで。覚えた品目のルールと Jev は呼び出し側が重ねる
 */
export function receiptFromDraft(draft: MailDraft, id: string, now: Date): Receipt {
  const items: ReceiptItem[] = draft.items.map((item) => ({
    name: item.name,
    amount: item.amount,
    categoryId: classifyItem(item.name, undefined, item.amount),
  }));
  return {
    id,
    storeName: draft.store,
    date: draft.date,
    total: draft.amount,
    items,
    currency: 'JPY',
    ...(draft.orderNumber ? { orderNumber: draft.orderNumber } : {}),
    source: 'mail',
    messageId: draft.messageId,
    status: 'pending',
    createdAt: now.toISOString(),
  };
}

/**
 * もうあるレシートを探す。注文番号が同じもの（画面で写しから先に登録した注文も含む）か、
 * 同じメールから置いたもの。消した（discarded）レシートも「ある」と数える。
 * 人が要らないと決めた注文を、発送のお知らせでもう一度置き直さないため
 */
export function findExisting(receipts: Receipt[], draft: MailDraft): Receipt | undefined {
  return receipts.find(
    (receipt) =>
      (draft.orderNumber !== undefined &&
        receipt.orderNumber !== undefined &&
        normalizeOrderNumber(receipt.orderNumber) === draft.orderNumber) ||
      (receipt.messageId !== undefined && receipt.messageId === draft.messageId),
  );
}
