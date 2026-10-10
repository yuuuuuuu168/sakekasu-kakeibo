import type { Currency, ForeignAmount, Receipt } from './types';

/**
 * 家計簿の金額は円の整数のまま。ドルで払ったものは、レシートの側だけがドルを持つ。
 *
 * ドルのレシートは total と品目の amount をセント（最小単位）の整数で持つ。小数を
 * 持ち込まないのは円と同じ理由で、品目の合計が合計と 1 セントずれるのを避けるため。
 * 明細（Transaction.amount）と内訳は常に円で、上限と叱りは円だけを見る。
 */

/** レートが分からないときの 1 ドルの円。保存済みのレシートにレートがあればそちらを使う */
export const DEFAULT_USD_RATE = 150;

/**
 * ドルのレシートを円の明細に当てるとき、換算額からどこまで離れてよいか（比率）。
 * カードの換算はその日の相場に事務手数料（1.6〜2.5% ほど）が乗り、計上日までに相場も動く。
 * 金額の一致を必須にできないので、この幅で候補に入れて日付と店名で絞る。
 */
export const FOREIGN_AMOUNT_TOLERANCE = 0.06;

export const CURRENCIES: readonly Currency[] = ['JPY', 'USD'];

export const CURRENCY_LABELS: Record<Currency, string> = {
  JPY: '円',
  USD: 'ドル',
};

/** 1 単位（1 円、1 ドル）が最小単位でいくつか */
export function minorUnit(currency: Currency): number {
  return currency === 'USD' ? 100 : 1;
}

/** 画面や OCR の数（12.34 ドル）を、保存する最小単位の整数（1234 セント）に直す */
export function toMinor(value: number, currency: Currency): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * minorUnit(currency));
}

/** 最小単位の整数を、画面に出す数（12.34）に戻す */
export function fromMinor(amount: number, currency: Currency): number {
  return amount / minorUnit(currency);
}

export function receiptCurrency(receipt: Pick<Receipt, 'currency'>): Currency {
  return receipt.currency ?? 'JPY';
}

export function formatMoney(amount: number, currency: Currency = 'JPY'): string {
  const sign = amount < 0 ? '-' : '';
  if (currency === 'USD') {
    const dollars = Math.abs(amount) / 100;
    return `${sign}$${dollars.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return `${sign}¥${Math.abs(amount).toLocaleString('ja-JP')}`;
}

/** 最小単位の金額を、1 ドル rate 円で円に直す */
export function toYenAt(amount: number, currency: Currency, rate: number): number {
  if (currency === 'JPY') return amount;
  return Math.round((amount / minorUnit(currency)) * rate);
}

/** 円に直した合計。ドルのレシートでレートが無ければ DEFAULT_USD_RATE で見積もる */
export function receiptYenTotal(receipt: Pick<Receipt, 'currency' | 'total' | 'exchangeRate'>): number {
  const currency = receiptCurrency(receipt);
  return toYenAt(receipt.total, currency, usableRate(receipt.exchangeRate) ?? DEFAULT_USD_RATE);
}

/**
 * 請求された円とレシートのドルから、実際に使われたレートを出す（小数 2 桁）。
 * カードの明細に当てたときに残しておくと、次のドルのレシートの見積もりが実勢に寄る。
 */
export function impliedRate(yen: number, cents: number): number | undefined {
  if (cents <= 0 || yen <= 0) return undefined;
  return Math.round((yen / (cents / 100)) * 100) / 100;
}

/**
 * 新しいドルのレシートに最初に入れるレート。日付の新しいドルのレシートに残っているレートを使い、
 * 1 枚も無ければ DEFAULT_USD_RATE。
 */
export function latestUsdRate(receipts: Receipt[]): number {
  const latest = receipts
    .filter((receipt) => receipt.currency === 'USD' && usableRate(receipt.exchangeRate) !== undefined)
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  return latest?.exchangeRate ?? DEFAULT_USD_RATE;
}

export function usableRate(rate: number | undefined): number | undefined {
  return rate !== undefined && Number.isFinite(rate) && rate > 0 ? rate : undefined;
}

/** 通貨を切り替えたとき、画面に見えている数はそのままにして最小単位だけ直す（12 円 → 12 ドル） */
export function convertDisplayed(amount: number, from: Currency, to: Currency): number {
  return toMinor(fromMinor(amount, from), to);
}

/** 明細に残すドルの控え。円のレシートなら undefined */
export function foreignOf(receipt: Pick<Receipt, 'currency' | 'total'>): ForeignAmount | undefined {
  const currency = receiptCurrency(receipt);
  return currency === 'JPY' ? undefined : { currency, amount: receipt.total };
}
