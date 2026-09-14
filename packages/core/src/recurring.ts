/**
 * 先に登録しておく定期的な支払い。
 *
 * ここから明細は作らない。作ると取り込んだ明細と必ず重なり、重複の判定を通す羽目になる。
 * 代わりに「その月に発生するはずの支払い」を数えて、着地見込みと残り回数に使う。
 * 口座引き落としのように明細を取り込まない支払いは、この見込みの中にだけ現れる。
 */

import { addMonths, dateInMonth, monthDiff, monthOf } from './date';
import { normalizeMerchant } from './merchant';
import type { RecurringPayment, Transaction } from './types';

/** 固定額として登録したものの、突き合わせで許す金額のずれ。増税や値上げで数 % は動く */
const AMOUNT_TOLERANCE_RATE = 0.1;
const AMOUNT_TOLERANCE_MIN = 100;

/** その月に発生する（はずの）支払い 1 回分 */
export type RecurringOccurrence = {
  paymentId: string;
  label: string;
  categoryId: string;
  /** 何回目か。1 始まり */
  index: number;
  /** 引き落とし日。YYYY-MM-DD */
  date: string;
  /** 円。突き合った明細があればその明細の金額、無ければ登録額 */
  amount: number;
  /** 登録してある額。金額が動くものでは amount と違う */
  plannedAmount: number;
  /** 突き合った明細の ID。入っていればこの回は実績として既に入っている */
  transactionId?: string;
};

/** 何か月おきか。壊れた値でも 1 以上にする */
export function intervalMonthsOf(payment: RecurringPayment): number {
  const interval = Math.trunc(payment.intervalMonths ?? 1);
  return Number.isFinite(interval) && interval >= 1 ? interval : 1;
}

/** 全部で何回の支払いか。回数も最終月も入っていなければ終わりが無い（undefined） */
export function totalCountOf(payment: RecurringPayment): number | undefined {
  const interval = intervalMonthsOf(payment);
  const byCount = payment.totalCount !== undefined && payment.totalCount > 0 ? Math.trunc(payment.totalCount) : undefined;
  const byEndMonth =
    payment.endMonth !== undefined && payment.endMonth >= payment.startMonth
      ? Math.floor(monthDiff(payment.startMonth, payment.endMonth) / interval) + 1
      : undefined;

  if (byCount === undefined) return byEndMonth;
  if (byEndMonth === undefined) return byCount;
  // 回数と最終月の両方が入っていたら、先に来る方で終わる
  return Math.min(byCount, byEndMonth);
}

/** その月が何回目の支払いか。発生しない月なら undefined */
export function occurrenceIndex(payment: RecurringPayment, month: string): number | undefined {
  const elapsed = monthDiff(payment.startMonth, month);
  if (elapsed < 0) return undefined;

  const interval = intervalMonthsOf(payment);
  if (elapsed % interval !== 0) return undefined;

  const index = elapsed / interval + 1;
  const total = totalCountOf(payment);
  if (total !== undefined && index > total) return undefined;
  return index;
}

/** その月の支払い 1 回分。発生しない月なら undefined。突き合わせはしない */
export function occurrenceOfMonth(payment: RecurringPayment, month: string): RecurringOccurrence | undefined {
  const index = occurrenceIndex(payment, month);
  if (index === undefined) return undefined;
  const amount = Math.round(payment.amount);
  return {
    paymentId: payment.id,
    label: payment.label,
    categoryId: payment.categoryId,
    index,
    date: dateInMonth(month, payment.dayOfMonth),
    amount,
    plannedAmount: amount,
  };
}

export type RecurringMonthInput = {
  /** YYYY-MM */
  month: string;
  payments: RecurringPayment[];
  /** 突き合わせに使う明細。その月の分だけ見る */
  transactions?: Transaction[];
};

/**
 * その月に発生する支払いを並べ、取り込み済みの明細と突き合わせる。
 * 突き合った回は `transactionId` が入り、金額は明細のものになる。
 * 停止したものは出さない。
 */
export function recurringOccurrences(input: RecurringMonthInput): RecurringOccurrence[] {
  const occurrences = input.payments
    .filter((payment) => !payment.archived)
    .map((payment) => [payment, occurrenceOfMonth(payment, input.month)] as const)
    .filter((pair): pair is readonly [RecurringPayment, RecurringOccurrence] => pair[1] !== undefined)
    .sort((a, b) => a[1].date.localeCompare(b[1].date));

  const candidates = (input.transactions ?? []).filter((txn) => monthOf(txn.date) === input.month && txn.amount > 0);
  const used = new Set<string>();
  const matched: RecurringOccurrence[] = [];

  for (const [payment, occurrence] of occurrences) {
    const txn = pickTransaction(payment, occurrence, candidates, used);
    if (!txn) {
      matched.push(occurrence);
      continue;
    }
    used.add(txn.id);
    matched.push({ ...occurrence, amount: txn.amount, transactionId: txn.id });
  }

  return matched;
}

/** 店舗名で絞り、金額の近い 1 件を取る。同じ明細を 2 つの支払いに割り当てない */
function pickTransaction(
  payment: RecurringPayment,
  occurrence: RecurringOccurrence,
  candidates: Transaction[],
  used: Set<string>,
): Transaction | undefined {
  const pattern = normalizeMerchant(payment.merchantPattern || payment.label);
  if (pattern === '') return undefined;

  const tolerance = Math.max(AMOUNT_TOLERANCE_MIN, Math.round(occurrence.plannedAmount * AMOUNT_TOLERANCE_RATE));

  const hits = candidates.filter((txn) => {
    if (used.has(txn.id)) return false;
    if (!normalizeMerchant(txn.rawMerchant || txn.merchant).includes(pattern)) return false;
    // 金額が動くものは額で絞れない。店舗名だけで当てる
    if (payment.variableAmount) return true;
    return Math.abs(txn.amount - occurrence.plannedAmount) <= tolerance;
  });

  return hits.sort((a, b) => {
    const byAmount = Math.abs(a.amount - occurrence.plannedAmount) - Math.abs(b.amount - occurrence.plannedAmount);
    if (byAmount !== 0) return byAmount;
    return Math.abs(dayOf(a.date) - dayOf(occurrence.date)) - Math.abs(dayOf(b.date) - dayOf(occurrence.date));
  })[0];
}

function dayOf(date: string): number {
  return Number(date.slice(8, 10));
}

export type RecurringStatus = {
  paymentId: string;
  label: string;
  /** 次の支払日。YYYY-MM-DD。終わっていれば undefined */
  nextDate?: string;
  /** 次が何回目か */
  nextIndex?: number;
  /** 全部で何回か。終わりが決まっていなければ undefined */
  totalCount?: number;
  /** 払い終えた回数 */
  paidCount: number;
  /** 残り回数。終わりが決まっていなければ undefined */
  remainingCount?: number;
  /** 残額。回数か総額が決まっているときだけ出る */
  remainingAmount?: number;
  /** 最後の支払いの月。終わりが決まっていれば */
  lastMonth?: string;
  /** 支払いが全部終わっている。停止したものもここに入る */
  finished: boolean;
};

/**
 * あと何回でいくら残っているか。
 * 総額を入れてあれば「総額 − 登録額 × 払った回数」を残額にする。
 * 入っていなければ「登録額 × 残り回数」。終わりが決まっていないものは残額を出さない。
 */
export function recurringStatus(payment: RecurringPayment, today: string): RecurringStatus {
  const interval = intervalMonthsOf(payment);
  const totalCount = totalCountOf(payment);
  const amount = Math.round(payment.amount);
  const lastMonth = totalCount === undefined ? undefined : addMonths(payment.startMonth, (totalCount - 1) * interval);

  const base: RecurringStatus = { paymentId: payment.id, label: payment.label, totalCount, lastMonth, paidCount: 0, finished: false };
  if (payment.archived) {
    const paidCount = totalCount === undefined ? countPaid(payment, today, interval) : Math.min(totalCount, countPaid(payment, today, interval));
    return { ...base, paidCount, remainingCount: totalCount === undefined ? undefined : 0, remainingAmount: totalCount === undefined ? undefined : 0, finished: true };
  }

  const next = nextOccurrenceMonth(payment, today, interval);
  if (next === undefined) {
    const paidCount = totalCount ?? countPaid(payment, today, interval);
    return {
      ...base,
      paidCount,
      remainingCount: totalCount === undefined ? undefined : 0,
      remainingAmount: totalCount === undefined ? undefined : 0,
      finished: true,
    };
  }

  const nextIndex = occurrenceIndex(payment, next);
  const paidCount = (nextIndex ?? 1) - 1;
  const remainingCount = totalCount === undefined ? undefined : Math.max(0, totalCount - paidCount);

  return {
    ...base,
    nextDate: dateInMonth(next, payment.dayOfMonth),
    nextIndex,
    paidCount,
    remainingCount,
    remainingAmount: remainingAmountOf(payment, amount, paidCount, remainingCount),
  };
}

function remainingAmountOf(
  payment: RecurringPayment,
  amount: number,
  paidCount: number,
  remainingCount: number | undefined,
): number | undefined {
  if (payment.totalAmount !== undefined && payment.totalAmount > 0) {
    return Math.max(0, Math.round(payment.totalAmount) - amount * paidCount);
  }
  return remainingCount === undefined ? undefined : amount * remainingCount;
}

/** 今日以降で最初に来る支払いの月。もう無ければ undefined */
function nextOccurrenceMonth(payment: RecurringPayment, today: string, interval: number): string | undefined {
  const elapsed = monthDiff(payment.startMonth, monthOf(today));
  const steps = elapsed <= 0 ? 0 : Math.ceil(elapsed / interval);

  for (const candidate of [steps, steps + 1]) {
    const month = addMonths(payment.startMonth, candidate * interval);
    if (occurrenceIndex(payment, month) === undefined) return undefined;
    if (dateInMonth(month, payment.dayOfMonth) >= today) return month;
  }
  return undefined;
}

/** 今日までに払い終えた回数 */
function countPaid(payment: RecurringPayment, today: string, interval: number): number {
  const elapsed = monthDiff(payment.startMonth, monthOf(today));
  if (elapsed < 0) return 0;
  const done = Math.floor(elapsed / interval);
  // 今月分は引き落とし日を過ぎていれば払ったとみなす
  const thisMonth = addMonths(payment.startMonth, done * interval);
  const paid = dateInMonth(thisMonth, payment.dayOfMonth) < today ? done + 1 : done;
  return Math.max(0, paid);
}
