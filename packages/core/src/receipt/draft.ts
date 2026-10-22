import { formatMoney, toMinor } from '../currency';
import { normalizeOrderNumber } from '../duplicate';
import { toPaymentMethod } from '../payment';
import type { Currency, ReceiptItem, SourceKind } from '../types';
import { classifyItem } from './items';

/*
 * レシートの写真を読んだモデルの出力（JSON の文字列）を、家計簿の下書きに直す。
 * モデルを呼ぶのは Lambda（infra/lambda/ocr-receipt）だけで、ここは AWS に依存しない。
 */

type RawItem = {
  name?: unknown;
  amount?: unknown;
  quantity?: unknown;
};

type DraftItem = { name: string; amount: number; quantity?: number; categoryId: string };

/**
 * OCR が返すレシートの下書き。確定前なので id は持たない。
 * Lambda（ocr-receipt）が作り、画面が受け取って直す。どちらも同じ型を見る
 */
export type ReceiptDraft = {
  storeName: string;
  date: string;
  /** currency の最小単位の整数（円、セント）。品目の amount も同じ */
  total: number;
  items: ReceiptItem[];
  /** ドルのレシートと読めたときだけ入る。無ければ円 */
  currency?: Currency;
  /** 支払いの印字から読めた支払い方法。読めなければ無い */
  paymentMethod?: SourceKind;
  /** ネット通販の注文番号。読めなければ無い */
  orderNumber?: string;
  /** OCR が読み切れなかった項目の説明。画面に出して直させる */
  warnings?: string[];
};

/** normalizeDraft の結果。品目には必ず仮のカテゴリが付き、warnings は必ずある */
export type NormalizedDraft = ReceiptDraft & { items: DraftItem[]; warnings: string[] };

/**
 * 読み取り結果の要約。ログに出す分だけを取り出す。
 * 店名・品目名・金額・日付は出さない（読んだ中身はログに残さない）。
 */
export function summarizeDraft(draft: NormalizedDraft): {
  items: number;
  warnings: number;
  paymentMethod: SourceKind | null;
} {
  return { items: draft.items.length, warnings: draft.warnings.length, paymentMethod: draft.paymentMethod ?? null };
}

/**
 * モデルの出力を家計簿が扱える形に直す。
 * JSON が壊れていること、金額が文字列で来ることがいずれも起きるので、
 * 全部ここで吸収して warnings に残す。
 *
 * カテゴリはキーワード表（classifyItem）で仮に付ける。本番の判定は画面が
 * この後 /classify に聞きに行くので、ここで付けるのはその返事が来ないときの控え。
 *
 * `today` は日付の検算に使う。テストから固定できるように引数にしてある。
 */
export function normalizeDraft(text: string, today: Date = new Date()): NormalizedDraft {
  const warnings: string[] = [];
  const parsed = extractJson(text);
  if (!parsed) {
    return { storeName: '', date: '', total: 0, items: [], warnings: ['レシートを読み取れませんでした。手で入れてください。'] };
  }

  // 金額は印字の通貨の最小単位（円、セント）の整数に直す。小数のドルを持ち込まない
  const currency: Currency = parsed.currency === 'USD' ? 'USD' : 'JPY';
  const toAmount = (value: number) => toMinor(value, currency);
  const money = (value: number) => formatMoney(value, currency);

  let unreadable = 0;
  const items = (Array.isArray(parsed.items) ? (parsed.items as RawItem[]) : [])
    .map((item) => {
      const name = typeof item.name === 'string' ? item.name.trim() : '';
      const amount = toNumber(item.amount);
      if (name !== '' && amount === undefined) unreadable += 1;
      if (name === '' || amount === undefined) return undefined;
      return {
        name,
        amount: toAmount(amount),
        ...(toNumber(item.quantity) !== undefined ? { quantity: toNumber(item.quantity) } : {}),
        categoryId: classifyItem(name, undefined, toAmount(amount)),
      };
    })
    .filter((item): item is DraftItem => item !== undefined);
  if (unreadable > 0) warnings.push(`金額を読めなかった品目が ${unreadable} 件あります。手で足してください。`);

  const rawTotal = toNumber(parsed.total);
  const total = rawTotal === undefined ? undefined : toAmount(rawTotal);

  const flipped = total === undefined ? undefined : flipDiscount(items, total);
  if (flipped) warnings.push(`「${flipped.name}」を値引き（${money(flipped.amount)}）として入れました。違っていたら直してください。`);

  const itemsTotal = items.reduce((sum, item) => sum + item.amount, 0);
  if (total === undefined) warnings.push('合計を読み取れませんでした。入れ直してください。');
  else if (items.length > 0 && Math.abs(total - itemsTotal) > Math.max(50, Math.round(total * 0.1))) {
    warnings.push(`品目の合計（${money(itemsTotal)}）が合計（${money(total)}）と離れています。読み落としがあるかもしれません。`);
  }
  if (items.length === 0) warnings.push('品目を読み取れませんでした。手で足してください。');

  const storeName = typeof parsed.storeName === 'string' ? parsed.storeName.trim() : '';
  if (storeName === '') warnings.push('店名を読み取れませんでした。');

  const date = typeof parsed.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date) ? parsed.date : '';
  if (date === '') warnings.push('日付を読み取れませんでした。');
  else {
    const doubt = doubtDate(date, today);
    if (doubt) warnings.push(doubt);
  }

  const paymentMethod = toPaymentMethod(parsed.paymentMethod);
  const orderNumber = typeof parsed.orderNumber === 'string' ? normalizeOrderNumber(parsed.orderNumber) : undefined;

  if (currency === 'USD') warnings.push('ドルのレシートとして読みました。円に直すレートを確かめてください。');

  return {
    storeName,
    date,
    total: total ?? itemsTotal,
    items,
    ...(currency === 'USD' ? { currency } : {}),
    ...(paymentMethod ? { paymentMethod } : {}),
    ...(orderNumber ? { orderNumber } : {}),
    warnings,
  };
}

/**
 * 値引きの行を正の金額で読んでしまったものを 1 つだけ直す。
 * 品目の合計が合計より 2×a 多く、金額 a の正の品目がちょうど 1 つあるときに限り、
 * その品目を負にする。候補が複数あればどれか決められないので触らない。
 * 直した品目を返す（直さなければ undefined）。
 */
function flipDiscount(items: DraftItem[], total: number): DraftItem | undefined {
  const excess = items.reduce((sum, item) => sum + item.amount, 0) - total;
  if (excess <= 0 || excess % 2 !== 0) return undefined;
  const candidates = items.filter((item) => item.amount === excess / 2);
  if (candidates.length !== 1) return undefined;
  const target = candidates[0];
  target.amount = -target.amount;
  // 正の金額で付けたカテゴリ（食費など）のままだと、値引きが品目の側に混ざる
  target.categoryId = classifyItem(target.name, undefined, target.amount);
  return target;
}

/** 日本時間の今日から見て、レシートの日付として不自然なら理由を返す */
function doubtDate(date: string, today: Date): string | undefined {
  const day = Date.parse(`${date}T00:00:00+09:00`);
  if (Number.isNaN(day)) return '日付を読み取れませんでした。';
  const DAY = 24 * 60 * 60 * 1000;
  if (day > today.getTime() + DAY) return `日付（${date}）が先の日付になっています。読み違いかもしれません。`;
  if (day < today.getTime() - 365 * DAY) return `日付（${date}）が 1 年以上前です。読み違いかもしれません。`;
  return undefined;
}

function extractJson(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const cleaned = value.replace(/[,¥円$\s]/g, '').replace(/^USD/i, '');
    const parsed = Number(cleaned);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}
