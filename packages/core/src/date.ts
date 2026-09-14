/** 日付は YYYY-MM-DD の文字列で持つ。月は YYYY-MM。Date を持ち回さないのはタイムゾーンを踏まないため */

const YMD = /(\d{4})\s*[/\-.年]\s*(\d{1,2})\s*[/\-.月]\s*(\d{1,2})/;
const MD = /^(\d{1,2})\s*[/\-.月]\s*(\d{1,2})/;
const COMPACT = /^(\d{4})(\d{2})(\d{2})$/;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * 明細の日付セルを YYYY-MM-DD に直す。
 * 年の無い「9/12」形式は referenceYear を補う。カード会社の CSV にまだある。
 */
export function parseDateCell(raw: string, referenceYear?: number): string | undefined {
  if (raw == null) return undefined;
  const text = raw.normalize('NFKC').trim();
  if (text === '') return undefined;

  const compact = COMPACT.exec(text);
  if (compact) {
    const [, y, m, d] = compact;
    return isRealDate(+y, +m, +d) ? `${y}-${pad(+m)}-${pad(+d)}` : undefined;
  }

  const ymd = YMD.exec(text);
  if (ymd) {
    const [, y, m, d] = ymd;
    return isRealDate(+y, +m, +d) ? `${y}-${pad(+m)}-${pad(+d)}` : undefined;
  }

  const md = MD.exec(text);
  if (md) {
    const year = referenceYear ?? new Date().getFullYear();
    const [, m, d] = md;
    return isRealDate(year, +m, +d) ? `${year}-${pad(+m)}-${pad(+d)}` : undefined;
  }

  return undefined;
}

export function looksLikeDate(raw: string): boolean {
  return parseDateCell(raw) !== undefined;
}

export function monthOf(date: string): string {
  return date.slice(0, 7);
}

export function diffDays(a: string, b: string): number {
  const left = Date.parse(`${a}T00:00:00Z`);
  const right = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(left) || Number.isNaN(right)) return Number.POSITIVE_INFINITY;
  return Math.round((left - right) / 86_400_000);
}

export function daysInMonth(month: string): number {
  const [year, mon] = month.split('-').map(Number);
  return new Date(Date.UTC(year, mon, 0)).getUTCDate();
}

/** 月を前後に動かす。YYYY-MM を跨いで年も繰り上がる */
export function addMonths(month: string, delta: number): string {
  const [year, mon] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, mon - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}`;
}

/** from から to までの月数。to が前なら負 */
export function monthDiff(from: string, to: string): number {
  const [fromYear, fromMon] = from.split('-').map(Number);
  const [toYear, toMon] = to.split('-').map(Number);
  return (toYear - fromYear) * 12 + (toMon - fromMon);
}

/** 月と日から YYYY-MM-DD を作る。その月に無い日（2 月の 31 日）は月末に丸める */
export function dateInMonth(month: string, day: number): string {
  const clamped = Math.min(Math.max(1, Math.trunc(day)), daysInMonth(month));
  return `${month}-${pad(clamped)}`;
}

export function previousMonth(month: string): string {
  return addMonths(month, -1);
}

/** 月の何日目かを日数で返す。当月なら今日、過去の月ならその月の日数 */
export function elapsedDays(month: string, today: string): number {
  if (monthOf(today) === month) return Number(today.slice(8, 10));
  return today > month ? daysInMonth(month) : 0;
}
