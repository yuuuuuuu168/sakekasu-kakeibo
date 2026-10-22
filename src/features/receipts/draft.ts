import {
  RECEIPT_IMAGE_TYPES,
  SOURCE_LABELS,
  convertDisplayed,
  formatYen,
  impliedRate,
  normalizeOrderNumber,
  receiptCurrency,
  receiptYenTotal,
  usableRate,
  type Currency,
  type Receipt,
  type ReceiptItem,
  type SourceKind,
} from '@kakeibo/core';
import { todayIso } from '../../lib/month';

/*
 * レシートの画面の下書き（読み取り結果か、開いた保存済みのレシート）と、その扱い。
 * 画面の状態に結びついた形なので core ではなくここに置くが、どれも純粋な処理にしてある。
 */

export type Draft = {
  id: string;
  storeName: string;
  date: string;
  /** 合計と品目の金額は currency の最小単位（円、セント） */
  total: number;
  items: DraftItem[];
  currency: Currency;
  /** ドルのときの 1 ドルの円。円のときは使わない */
  exchangeRate?: number;
  imageKey?: string;
  /** 分けて撮ったときの全部の写真。1 枚なら持たない */
  imageKeys?: string[];
  /** 明細を作って登録するときの支払い方法。OCR が支払いの印字から読めたらそれ、無ければ現金 */
  paidWith: SourceKind;
  /** ネット通販の注文番号。OCR が読めたもの、または人が入れたもの。空なら持たない */
  orderNumber?: string;
  /**
   * 保存前の警告で「別の買い物」と言われた保存済みのレシート ID。保存するとレシートの印になり、
   * 保存後の重複の組にも出なくなる（印は片側にあれば効く）
   */
  notDuplicateOf?: string[];
  warnings?: string[];
};

/**
 * 下書きの品目。categoryEdited は人がカテゴリを選び直した印で、保存するときに
 * その品目名とカテゴリを覚える（learnItemRules）。レシートには残さない。
 */
export type DraftItem = ReceiptItem & { categoryEdited?: boolean };

/**
 * OCR が読める形式（core の RECEIPT_IMAGE_TYPES）。読む側（ocr-receipt）が中身のバイト列で確かめるのも、
 * API が署名付き URL を出すのもこの 3 つ。
 * カメラロールから選ぶ入力にはこれを列挙して渡す。iOS は HEIC の写真をここに無い形式と見て
 * JPEG に直してから渡してくれる。`image/*` だと HEIC のまま届いて OCR で落ちることがある。
 */
export const READABLE_IMAGE_TYPES = Object.keys(RECEIPT_IMAGE_TYPES);

export function newDraftId(): string {
  return `r-${Date.now().toString(36)}`;
}

export function emptyDraft(): Draft {
  return { id: newDraftId(), storeName: '', date: todayIso(), total: 0, items: [], currency: 'JPY', paidWith: 'cash' };
}

/** 保存済みのレシートを直すときの下書き。読み取り結果と同じ欄に載せる */
export function draftFromReceipt(receipt: Receipt): Draft {
  return {
    id: receipt.id,
    storeName: receipt.storeName,
    date: receipt.date,
    total: receipt.total,
    items: receipt.items,
    currency: receiptCurrency(receipt),
    ...(receipt.exchangeRate !== undefined ? { exchangeRate: receipt.exchangeRate } : {}),
    ...(receipt.imageKey ? { imageKey: receipt.imageKey } : {}),
    ...(receipt.imageKeys ? { imageKeys: receipt.imageKeys } : {}),
    paidWith: receipt.paidWith ?? 'cash',
    ...(receipt.orderNumber ? { orderNumber: receipt.orderNumber } : {}),
  };
}

/**
 * 写真のキーを下書きの欄にする。1 枚目は imageKey、分けて撮ったときだけ imageKeys に全部を持たせる
 * （1 枚で撮ったレシートの形はこれまでと変えない）
 */
export function imageFields(keys: string[]): Pick<Draft, 'imageKey' | 'imageKeys'> {
  if (keys.length === 0) return {};
  return { imageKey: keys[0], ...(keys.length > 1 ? { imageKeys: keys } : {}) };
}

/** 下書きの品目から、保存する品目を作る。覚えるための印を落とす */
export function toReceiptItems(items: DraftItem[]): ReceiptItem[] {
  return items.map(({ categoryEdited: _edited, ...item }) => item);
}

/**
 * 下書きから、レシートに保存する通貨の欄を作る。円なら何も持たせない（これまでのレシートと同じ形）。
 * `paidYen` は当てた明細の請求額。渡すと、そこから割り戻した実際のレートを残す。
 */
export function currencyFields(draft: Draft, paidYen?: number): Pick<Receipt, 'currency' | 'exchangeRate'> {
  if (draft.currency === 'JPY') return {};
  const rate = (paidYen !== undefined ? impliedRate(paidYen, draft.total) : undefined) ?? usableRate(draft.exchangeRate);
  return { currency: draft.currency, ...(rate !== undefined ? { exchangeRate: rate } : {}) };
}

/** 下書きの注文番号を、レシートに保存する欄にする。空や数字の無いものは持たせない */
export function orderNumberField(draft: Draft): Pick<Receipt, 'orderNumber'> {
  const orderNumber = draft.orderNumber ? normalizeOrderNumber(draft.orderNumber) : undefined;
  return orderNumber ? { orderNumber } : {};
}

/** 日付が入っていない下書き（日付の欄を空にしたもの）。API は YYYY-MM-DD でない日付を受け取らない */
export function lacksDate(draft: Draft): boolean {
  return !/^\d{4}-\d{2}-\d{2}$/.test(draft.date);
}

/** 円に直せない下書き（ドルなのにレートが無い）。明細を作れない */
export function lacksRate(draft: Draft): boolean {
  return draft.currency !== 'JPY' && usableRate(draft.exchangeRate) === undefined;
}

/** 登録ボタンの文言と、登録後の知らせに使う。「不明払い」とは言わないので分けている */
export function paymentPhrase(method: SourceKind): string {
  return method === 'unknown' ? '支払い方法不明' : `${SOURCE_LABELS[method]}払い`;
}

/** 品目の 1 行を差し替える */
export function updateItem(draft: Draft, index: number, patch: Partial<DraftItem>): Draft {
  return { ...draft, items: draft.items.map((row, position) => (position === index ? { ...row, ...patch } : row)) };
}

export function removeItem(draft: Draft, index: number): Draft {
  return { ...draft, items: draft.items.filter((_, position) => position !== index) };
}

/**
 * 通貨を切り替える。画面に見えている数はそのままにする（OCR が通貨を取り違えたとき用）。
 * ドルにしてレートが無ければ、`fallbackRate`（直近のドルのレシートのレート）を入れておく
 */
export function withCurrency(draft: Draft, next: Currency, fallbackRate: number | undefined): Draft {
  if (draft.currency === next) return draft;
  const convert = (amount: number) => convertDisplayed(amount, draft.currency, next);
  return {
    ...draft,
    currency: next,
    total: convert(draft.total),
    items: draft.items.map((item) => ({ ...item, amount: convert(item.amount) })),
    ...(next === 'USD' && usableRate(draft.exchangeRate) === undefined ? { exchangeRate: fallbackRate } : {}),
  };
}

/**
 * 新しく保存するレシートを下書きから組む。
 * asPayment ならレシートから明細を作る（status は cash）。そうでなければ、明細を選んでいれば当て（matched）、
 * 選んでいなければレシートだけ（pending）。`paidYen` は当てる明細の請求額
 */
export function receiptFromDraft(
  draft: Draft,
  options: { asPayment: boolean; txnId?: string; paidYen?: number; createdAt: string },
): Receipt {
  const { paidWith, currency: _currency, exchangeRate: _rate, orderNumber: _order, ...rest } = draft;
  const { asPayment, txnId } = options;
  return {
    ...rest,
    ...currencyFields(draft, options.paidYen),
    ...orderNumberField(draft),
    items: toReceiptItems(draft.items),
    status: asPayment ? 'cash' : txnId ? 'matched' : 'pending',
    ...(asPayment ? { paidWith } : {}),
    ...(txnId && !asPayment ? { txnId } : {}),
    createdAt: options.createdAt,
  };
}

/**
 * 保存済みのレシートを直した結果を組む。つながり（status・txnId・createdAt）は開いた時点のまま。
 * 円に戻したときにドルの欄が残らないよう、開いた時点の通貨の欄は外してから載せ直す。
 * `paidYen` は紐付けた明細の請求額（matched のときだけ渡す）
 */
export function editedReceipt(editing: Receipt, draft: Draft, paidYen?: number): Receipt {
  const { paidWith, warnings: _warnings, currency: _currency, exchangeRate: _rate, orderNumber: _order, ...rest } = draft;
  // 注文番号も通貨と同じく、消したときに開いた時点の番号が残らないよう外してから載せ直す
  const { currency: _was, exchangeRate: _wasRate, orderNumber: _wasOrder, ...base } = editing;
  return {
    ...base,
    ...rest,
    ...currencyFields(draft, paidYen),
    ...orderNumberField(draft),
    items: toReceiptItems(draft.items),
    ...(editing.status === 'cash' ? { paidWith } : {}),
  };
}

/** 下書きの合計を円に直した額の一言。ドルでレートがあるときだけ添える */
export function yenHint(draft: Draft): string | undefined {
  return draft.currency !== 'JPY' && !lacksRate(draft) ? `約 ${formatYen(receiptYenTotal(draft))}` : undefined;
}
