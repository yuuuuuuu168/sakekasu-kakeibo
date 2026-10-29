/**
 * 先に登録しておく定期的な支払い。
 *
 * 「その月に発生するはずの支払い」を数えて、着地見込みと残り回数に使う。
 * 支払日が来た回は明細も作る（planRecurringPosts）。月末の取り込みを待たずに実績へ入れるため。
 * 同じ支払いの明細を後から取り込んだら、作った方を消して取り込んだ方を残す。
 * 口座引き落としのように明細を取り込まない支払いは、作った明細がそのまま実績になる。
 */

import { addMonths, dateInMonth, monthDiff, monthOf, previousMonth } from './date';
import { normalizeMerchant } from './merchant';
import type { RecurringPayment, Transaction } from './types';

/** 定期支払いから作った明細の取り込み元の表示名 */
export const RECURRING_SOURCE_LABEL = '定期支払い';

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

/**
 * 店舗名で絞り、金額の近い 1 件を取る。同じ明細を 2 つの支払いに割り当てない。
 * 取り込んだ明細を先に見て、無ければその回のために作った明細を当てる
 */
function pickTransaction(
  payment: RecurringPayment,
  occurrence: RecurringOccurrence,
  candidates: Transaction[],
  used: Set<string>,
): Transaction | undefined {
  const pattern = normalizeMerchant(payment.merchantPattern || payment.label);

  const tolerance = Math.max(AMOUNT_TOLERANCE_MIN, Math.round(occurrence.plannedAmount * AMOUNT_TOLERANCE_RATE));

  const own = (txn: Transaction) => txn.recurring?.paymentId === payment.id && txn.recurring.month === monthOf(occurrence.date);
  const imported = candidates.filter((txn) => {
    if (used.has(txn.id) || txn.recurring !== undefined || pattern === '') return false;
    if (!normalizeMerchant(txn.rawMerchant || txn.merchant).includes(pattern)) return false;
    // 金額が動くものは額で絞れない。店舗名だけで当てる
    if (payment.variableAmount) return true;
    return Math.abs(txn.amount - occurrence.plannedAmount) <= tolerance;
  });
  // 取り込んだ明細が無ければ、この回のために作った明細を当てる。ほかの支払いの分は見ない
  if (imported.length === 0) return candidates.find((txn) => !used.has(txn.id) && own(txn));

  return imported.sort((a, b) => {
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

/** 定期支払いから作る明細の ID。支払いと月で決まるので、何度作っても同じ 1 件になる */
export function recurringTransactionId(paymentId: string, month: string): string {
  return `recurring-${paymentId}-${month}`;
}

export type RecurringPostInput = {
  payments: RecurringPayment[];
  transactions: Transaction[];
  /** YYYY-MM-DD。この日までに支払日を迎えた回を明細にする */
  today: string;
};

export type RecurringPostPlan = {
  /** 支払日を迎えたので作る明細 */
  create: Transaction[];
  /** 同じ支払いの明細を取り込んだので消す、作った明細の ID */
  remove: string[];
  /** postedThrough を進めた支払いの一覧（全件）。どれも変わらなければ undefined */
  recurring?: RecurringPayment[];
};

/**
 * 支払日を迎えた回の明細を作り、取り込んだ明細と重なった分を消す計画を立てる。保存は呼び出し側。
 *
 * - 作るのは postedThrough の翌月から今月まで。postedThrough が無い支払いは今月から作る。
 *   登録より前の月までさかのぼって作ると、取り込み済みの月に重ねてしまうため
 * - その回の明細をもう取り込んであれば作らない
 * - 作った明細と同じ回の明細を取り込んだら、作った方を消す
 *
 * 作った回は postedThrough に覚えておく。人が明細を消しても作り直さない。
 */
export function planRecurringPosts(input: RecurringPostInput): RecurringPostPlan {
  const { payments, transactions, today } = input;
  const thisMonth = monthOf(today);
  const existing = new Set(transactions.map((txn) => txn.id));
  const imported = transactions.filter((txn) => txn.recurring === undefined);

  // 突き合わせは月ごとに 1 回。同じ明細を 2 つの支払いに当てない規則を、支払いをまたいで効かせる
  const matchedOf = new Map<string, Map<string, string | undefined>>();
  const importedMatch = (month: string, paymentId: string): string | undefined => {
    let byPayment = matchedOf.get(month);
    if (!byPayment) {
      // 停止した支払いも突き合わせには入れる。停止前に作った明細を、取り込んだ明細に差し替えられるように
      const all = payments.map((payment) => ({ ...payment, archived: false }));
      byPayment = new Map(
        recurringOccurrences({ month, payments: all, transactions: imported }).map((occurrence) => [occurrence.paymentId, occurrence.transactionId]),
      );
      matchedOf.set(month, byPayment);
    }
    return byPayment.get(paymentId);
  };

  const remove = transactions
    .filter((txn) => txn.recurring !== undefined && importedMatch(txn.recurring.month, txn.recurring.paymentId) !== undefined)
    .map((txn) => txn.id);

  const create: Transaction[] = [];
  let changed = false;
  const recurring = payments.map((payment) => {
    if (payment.archived) return payment;

    let through = payment.postedThrough ?? previousMonth(thisMonth);
    for (let month = addMonths(through, 1); month <= thisMonth; month = addMonths(month, 1)) {
      const occurrence = occurrenceOfMonth(payment, month);
      if (occurrence && occurrence.date > today) break;
      if (occurrence) {
        const id = recurringTransactionId(payment.id, month);
        if (occurrence.amount > 0 && !existing.has(id) && importedMatch(month, payment.id) === undefined) {
          create.push(postedTransaction(payment, occurrence, id));
        }
      }
      through = month;
    }

    if (through === payment.postedThrough) return payment;
    changed = true;
    return { ...payment, postedThrough: through };
  });

  return { create, remove, ...(changed ? { recurring } : {}) };
}

function postedTransaction(payment: RecurringPayment, occurrence: RecurringOccurrence, id: string): Transaction {
  const rawMerchant = payment.merchantPattern?.trim() || payment.label;
  return {
    id,
    date: occurrence.date,
    amount: occurrence.amount,
    rawMerchant,
    merchant: payment.label,
    source: 'manual',
    sourceLabel: RECURRING_SOURCE_LABEL,
    splits: [{ id: `${id}-1`, amount: occurrence.amount, categoryId: payment.categoryId, origin: 'manual' }],
    needsDetail: false,
    recurring: { paymentId: payment.id, month: monthOf(occurrence.date) },
  };
}
