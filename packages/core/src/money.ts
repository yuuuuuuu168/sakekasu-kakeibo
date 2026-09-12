/**
 * 金額は円の整数で扱う。小数を持ち込むと内訳の合計が親と一致しなくなるため、
 * 境界（CSV の解析と OCR の結果）で必ず整数に丸める。
 */

export function toYen(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value);
}

const AMOUNT_PATTERN = /-?[\d,]+(?:\.\d+)?/;

/**
 * 明細の金額セルを円に直す。
 * 「1,200」「¥1,200」「1200円」「-1,200」「(1,200)」「△1,200」を受ける。
 * 括弧と △ と ▲ は会計の慣習で負の数を意味するので負にする。
 */
export function parseAmountCell(raw: string): number | undefined {
  if (raw == null) return undefined;
  const text = raw.normalize('NFKC').trim();
  if (text === '') return undefined;

  const negatedByNotation = /^[(（]/.test(text) || /^[△▲]/.test(text);
  const matched = AMOUNT_PATTERN.exec(text.replace(/[△▲]/g, ''));
  if (!matched) return undefined;

  const numeric = Number(matched[0].replace(/,/g, ''));
  if (!Number.isFinite(numeric)) return undefined;

  const yen = toYen(numeric);
  return negatedByNotation ? -Math.abs(yen) : yen;
}

export function formatYen(amount: number): string {
  const sign = amount < 0 ? '-' : '';
  return `${sign}¥${Math.abs(amount).toLocaleString('ja-JP')}`;
}

/** 0 除算を避けた比率。上限 0 のカテゴリに実績があれば Infinity ではなく 1 を超える値を返す */
export function ratio(actual: number, limit: number): number {
  if (limit > 0) return actual / limit;
  return actual > 0 ? Number.POSITIVE_INFINITY : 0;
}
