import type { SourceKind } from './types';

/** 明細の出どころの表示名。取り込み画面とレシート画面で同じ呼び方にする */
export const SOURCE_LABELS: Record<SourceKind, string> = {
  credit: 'クレジットカード',
  paypay: 'PayPay',
  suica: 'Suica',
  cash: '現金',
  unknown: '不明',
  manual: 'その他',
};

/**
 * レシートからそのまま明細を作るときに選べる支払い方法。並びは画面の選択肢の順。
 * 「不明」は古いレシートで払い方を覚えていないとき用。支出としては数える。
 */
export const RECEIPT_PAYMENT_METHODS: readonly SourceKind[] = ['cash', 'paypay', 'credit', 'suica', 'unknown'];

/** OCR に聞く支払い方法。印字から決められるものだけで、「不明」は人が選ぶ */
const READABLE_PAYMENT_METHODS: readonly SourceKind[] = ['cash', 'paypay', 'credit', 'suica'];

/**
 * OCR が読んだ支払い方法を選択肢に直す。選択肢に無いもの、読めなかったものは undefined。
 * 交通系 IC（PASMO・ICOCA なども）はプロンプトの側で suica に寄せている。家計簿の上では区別しない。
 */
export function toPaymentMethod(value: unknown): SourceKind | undefined {
  if (typeof value !== 'string') return undefined;
  return (READABLE_PAYMENT_METHODS as readonly string[]).includes(value) ? (value as SourceKind) : undefined;
}

/**
 * レシートから作った明細が、後で取り込む明細と二重になりうるか。
 * カードと PayPay は利用明細を取り込めるので、レシートからも作ると同じ支払いが 2 件になる。
 */
export function hasImportableStatement(source: SourceKind): boolean {
  return source === 'credit' || source === 'paypay';
}
