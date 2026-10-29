import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  occurrenceIndex,
  occurrenceOfMonth,
  planRecurringPosts,
  recurringOccurrences,
  recurringTransactionId,
  similarRecurringPayments,
  recurringStatus,
  totalCountOf,
} from '../recurring';
import type { RecurringPayment, Transaction } from '../types';

const NETFLIX: RecurringPayment = {
  id: 'r-netflix',
  label: 'Netflix',
  amount: 1590,
  categoryId: 'fees-membership',
  dayOfMonth: 5,
  startMonth: '2026-01',
};

/** 24 回の分割。総額 158,400 円 */
const IPHONE: RecurringPayment = {
  id: 'r-iphone',
  label: 'iPhone 16 分割',
  amount: 6600,
  categoryId: 'telecom',
  dayOfMonth: 27,
  startMonth: '2026-04',
  totalCount: 24,
  totalAmount: 158_400,
  merchantPattern: 'ドコモ',
};

/** 年払いのサブスク */
const YEARLY: RecurringPayment = {
  id: 'r-domain',
  label: 'ドメイン',
  amount: 1980,
  categoryId: 'fees-membership',
  dayOfMonth: 31,
  startMonth: '2026-02',
  intervalMonths: 12,
};

function txn(id: string, date: string, amount: number, merchant: string, categoryId = 'fees-membership'): Transaction {
  return {
    id,
    date,
    amount,
    rawMerchant: merchant,
    merchant,
    source: 'credit',
    sourceLabel: '楽天カード',
    splits: [{ id: `${id}-1`, amount, categoryId, origin: 'rule' }],
    needsDetail: false,
  };
}

describe('発生する月', () => {
  it('毎月のものは開始月から毎月発生する', () => {
    expect(occurrenceIndex(NETFLIX, '2025-12')).toBeUndefined();
    expect(occurrenceIndex(NETFLIX, '2026-01')).toBe(1);
    expect(occurrenceIndex(NETFLIX, '2026-09')).toBe(9);
  });

  it('回数が決まっているものは終わったら発生しない', () => {
    expect(occurrenceIndex(IPHONE, '2028-03')).toBe(24);
    expect(occurrenceIndex(IPHONE, '2028-04')).toBeUndefined();
  });

  it('年払いは 12 か月おきにだけ発生する', () => {
    expect(occurrenceIndex(YEARLY, '2026-02')).toBe(1);
    expect(occurrenceIndex(YEARLY, '2026-03')).toBeUndefined();
    expect(occurrenceIndex(YEARLY, '2027-02')).toBe(2);
  });

  it('最終月と回数は早い方が効く', () => {
    expect(totalCountOf({ ...IPHONE, endMonth: '2026-09' })).toBe(6);
    expect(totalCountOf({ ...IPHONE, endMonth: '2030-01' })).toBe(24);
    expect(totalCountOf(NETFLIX)).toBeUndefined();
  });

  it('その月に無い日は月末に丸める', () => {
    expect(occurrenceOfMonth(YEARLY, '2026-02')?.date).toBe('2026-02-28');
    expect(occurrenceOfMonth({ ...YEARLY, startMonth: '2028-02' }, '2028-02')?.date).toBe('2028-02-29');
  });
});

describe('明細との突き合わせ', () => {
  const transactions = [
    txn('t1', '2026-09-05', 1590, 'NETFLIX.COM'),
    txn('t2', '2026-09-27', 6600, '（株）ＮＴＴドコモ 1234', 'telecom'),
    txn('t3', '2026-09-12', 4200, 'セブンイレブン', 'food'),
  ];

  it('店舗名と金額で登録済みの支払いを当てる', () => {
    const occurrences = recurringOccurrences({ month: '2026-09', payments: [NETFLIX, IPHONE], transactions });
    expect(occurrences.map((item) => [item.paymentId, item.transactionId])).toEqual([
      ['r-netflix', 't1'],
      ['r-iphone', 't2'],
    ]);
  });

  it('金額が離れている明細には当てない', () => {
    const occurrences = recurringOccurrences({
      month: '2026-09',
      payments: [NETFLIX],
      transactions: [txn('t9', '2026-09-05', 9800, 'NETFLIX.COM')],
    });
    expect(occurrences[0].transactionId).toBeUndefined();
    expect(occurrences[0].amount).toBe(1590);
  });

  it('金額が動くものは店舗名だけで当て、金額は明細のものを使う', () => {
    const denki: RecurringPayment = {
      id: 'r-denki',
      label: '電気代',
      amount: 6000,
      categoryId: 'housing',
      dayOfMonth: 10,
      startMonth: '2026-01',
      merchantPattern: '東京電力',
      variableAmount: true,
    };
    const occurrences = recurringOccurrences({
      month: '2026-09',
      payments: [denki],
      transactions: [txn('t10', '2026-09-10', 13_400, '東京電力エナジーパートナー', 'housing')],
    });
    expect(occurrences[0]).toMatchObject({ transactionId: 't10', amount: 13_400, plannedAmount: 6000 });
  });

  it('1 つの明細を 2 つの支払いに割り当てない', () => {
    const twin: RecurringPayment = { ...NETFLIX, id: 'r-netflix-2', label: 'Netflix 2 契約目' };
    const occurrences = recurringOccurrences({ month: '2026-09', payments: [NETFLIX, twin], transactions });
    expect(occurrences.filter((item) => item.transactionId === 't1')).toHaveLength(1);
    expect(occurrences.some((item) => item.transactionId === undefined)).toBe(true);
  });

  it('停止したものは出さない', () => {
    const occurrences = recurringOccurrences({ month: '2026-09', payments: [{ ...NETFLIX, archived: true }], transactions });
    expect(occurrences).toEqual([]);
  });
});

describe('残り回数と残額', () => {
  it('次の支払日と残り回数を出す', () => {
    const status = recurringStatus(IPHONE, '2026-09-14');
    expect(status.nextDate).toBe('2026-09-27');
    expect(status.nextIndex).toBe(6);
    expect(status.paidCount).toBe(5);
    expect(status.remainingCount).toBe(19);
    // 総額 158,400 から払った 5 回分を引く
    expect(status.remainingAmount).toBe(158_400 - 6600 * 5);
    expect(status.lastMonth).toBe('2028-03');
    expect(status.finished).toBe(false);
  });

  it('引き落とし日を過ぎたら次は翌月になる', () => {
    const status = recurringStatus(IPHONE, '2026-09-28');
    expect(status.nextDate).toBe('2026-10-27');
    expect(status.remainingCount).toBe(18);
  });

  it('終わりが決まっていなければ残り回数も残額も出さない', () => {
    const status = recurringStatus(NETFLIX, '2026-09-14');
    expect(status.nextDate).toBe('2026-10-05');
    expect(status.remainingCount).toBeUndefined();
    expect(status.remainingAmount).toBeUndefined();
    expect(status.finished).toBe(false);
  });

  it('払い終えたものは残り 0 で終わりになる', () => {
    const status = recurringStatus(IPHONE, '2028-04-01');
    expect(status.finished).toBe(true);
    expect(status.nextDate).toBeUndefined();
    expect(status.remainingCount).toBe(0);
    expect(status.remainingAmount).toBe(0);
  });

  it('停止したものは終わり扱い', () => {
    expect(recurringStatus({ ...NETFLIX, archived: true }, '2026-09-14').finished).toBe(true);
  });

  it('総額を入れていなければ残額は登録額 × 残り回数', () => {
    const status = recurringStatus({ ...IPHONE, totalAmount: undefined }, '2026-09-14');
    expect(status.remainingAmount).toBe(6600 * 19);
  });
});

describe('不変条件', () => {
  it('残り回数は 0 以上、全回数以下', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 60 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 31 }),
        fc.integer({ min: 0, max: 47 }),
        (totalCount, intervalMonths, dayOfMonth, elapsed) => {
          const payment: RecurringPayment = { ...IPHONE, totalCount, intervalMonths, dayOfMonth, startMonth: '2026-01' };
          const month = 2026 * 12 + elapsed;
          const today = `${Math.floor(month / 12)}-${String((month % 12) + 1).padStart(2, '0')}-15`;
          const status = recurringStatus(payment, today);
          expect(status.paidCount).toBeGreaterThanOrEqual(0);
          expect(status.paidCount).toBeLessThanOrEqual(totalCount);
          expect(status.remainingCount).toBe(totalCount - status.paidCount);
          expect(status.remainingAmount).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });

  it('発生する月の回数は開始から終わりまでで全回数にちょうど一致する', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 40 }), fc.integer({ min: 1, max: 12 }), (totalCount, intervalMonths) => {
        const payment: RecurringPayment = { ...IPHONE, totalCount, intervalMonths, startMonth: '2026-01' };
        let found = 0;
        for (let index = 0; index < totalCount * intervalMonths + 12; index += 1) {
          const month = `${2026 + Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
          if (occurrenceOfMonth(payment, month)) found += 1;
        }
        expect(found).toBe(totalCount);
      }),
    );
  });
});

describe('支払日に明細を作る', () => {
  it('支払日を迎えた回だけ作り、作り終えた月を覚える', () => {
    const plan = planRecurringPosts({ payments: [NETFLIX, IPHONE], transactions: [], today: '2026-10-10' });

    // Netflix は 5 日で迎えている。iPhone は 27 日でまだ
    expect(plan.create).toEqual([
      expect.objectContaining({
        id: recurringTransactionId('r-netflix', '2026-10'),
        date: '2026-10-05',
        amount: 1590,
        sourceLabel: '定期支払い',
        recurring: { paymentId: 'r-netflix', month: '2026-10' },
        splits: [expect.objectContaining({ amount: 1590, categoryId: 'fees-membership' })],
      }),
    ]);
    expect(plan.remove).toEqual([]);
    expect(plan.recurring?.find((p) => p.id === 'r-netflix')?.postedThrough).toBe('2026-10');
    // まだの回は先月までで止めておき、迎えた日に作る
    expect(plan.recurring?.find((p) => p.id === 'r-iphone')?.postedThrough).toBe('2026-09');
  });

  it('作り終えた月の翌月から今日までをまとめて作る', () => {
    const payment = { ...NETFLIX, postedThrough: '2026-07' };
    const plan = planRecurringPosts({ payments: [payment], transactions: [], today: '2026-10-04' });

    expect(plan.create.map((t) => t.date)).toEqual(['2026-08-05', '2026-09-05']);
    expect(plan.recurring?.[0]?.postedThrough).toBe('2026-09');
  });

  it('印の無い支払いは今月から作る。登録前の月まではさかのぼらない', () => {
    const plan = planRecurringPosts({ payments: [NETFLIX], transactions: [], today: '2026-10-29' });
    expect(plan.create.map((t) => t.date)).toEqual(['2026-10-05']);
  });

  it('作り終えた月は、明細を人が消しても作り直さない', () => {
    const payment = { ...NETFLIX, postedThrough: '2026-10' };
    const plan = planRecurringPosts({ payments: [payment], transactions: [], today: '2026-10-29' });
    expect(plan).toEqual({ create: [], remove: [] });
  });

  it('その回の明細を取り込んであれば作らない', () => {
    const imported = txn('t1', '2026-10-05', 1590, 'NETFLIX.COM');
    const plan = planRecurringPosts({ payments: [{ ...NETFLIX, postedThrough: '2026-09' }], transactions: [imported], today: '2026-10-10' });

    expect(plan.create).toEqual([]);
    expect(plan.recurring?.[0]?.postedThrough).toBe('2026-10');
  });

  it('同じ回の明細を後から取り込んだら、作った明細を消す', () => {
    const first = planRecurringPosts({ payments: [NETFLIX], transactions: [], today: '2026-10-10' });
    const posted = first.create[0]!;
    const imported = txn('t1', '2026-10-06', 1590, 'NETFLIX.COM');

    const plan = planRecurringPosts({ payments: first.recurring!, transactions: [posted, imported], today: '2026-10-10' });
    expect(plan).toEqual({ create: [], remove: [posted.id] });
  });

  it('取り込んだ明細が別の回のものなら、作った明細は残す', () => {
    const first = planRecurringPosts({ payments: [NETFLIX], transactions: [], today: '2026-10-10' });
    const posted = first.create[0]!;
    const lastMonth = txn('t1', '2026-09-05', 1590, 'NETFLIX.COM');

    const plan = planRecurringPosts({ payments: first.recurring!, transactions: [posted, lastMonth], today: '2026-10-10' });
    expect(plan.remove).toEqual([]);
  });

  it('停止した支払いは作らない', () => {
    const plan = planRecurringPosts({ payments: [{ ...NETFLIX, archived: true }], transactions: [], today: '2026-10-10' });
    expect(plan).toEqual({ create: [], remove: [] });
  });

  it('作った明細は着地見込みで突き合った回として数え、二重に数えない', () => {
    const posted = planRecurringPosts({ payments: [NETFLIX], transactions: [], today: '2026-10-10' }).create;
    const occurrences = recurringOccurrences({ month: '2026-10', payments: [NETFLIX], transactions: posted });
    expect(occurrences[0]?.transactionId).toBe(posted[0]?.id);
  });

  it('作った明細はほかの支払いには当てない', () => {
    const posted = planRecurringPosts({ payments: [NETFLIX], transactions: [], today: '2026-10-10' }).create;
    const twin = { ...NETFLIX, id: 'r-netflix-2' };
    const occurrences = recurringOccurrences({ month: '2026-10', payments: [twin], transactions: posted });
    expect(occurrences[0]?.transactionId).toBeUndefined();
  });

  it('何度立て直しても、適用したあとは何もしない', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 31 }), fc.integer({ min: 1, max: 28 }), (dayOfMonth, todayDay) => {
        const payment = { ...NETFLIX, dayOfMonth, postedThrough: '2026-06' };
        const today = `2026-10-${String(todayDay).padStart(2, '0')}`;
        const first = planRecurringPosts({ payments: [payment], transactions: [], today });
        const second = planRecurringPosts({ payments: first.recurring ?? [payment], transactions: first.create, today });
        expect(second).toEqual({ create: [], remove: [] });
      }),
    );
  });
});

describe('二重に登録したかもしれない支払い', () => {
  it('金額・引き落とし日・周期が同じものを返す。自分と停止したものは除く', () => {
    const twin = { ...NETFLIX, id: 'r-twin', label: 'ネトフリ' };
    const stopped = { ...NETFLIX, id: 'r-stopped', archived: true };
    const yearly = { ...NETFLIX, id: 'r-yearly', intervalMonths: 12 };
    const otherDay = { ...NETFLIX, id: 'r-day', dayOfMonth: 6 };
    expect(similarRecurringPayments(NETFLIX, [NETFLIX, twin, stopped, yearly, otherDay]).map((p) => p.id)).toEqual(['r-twin']);
  });

  it('登録前（ID がまだ無い）でも比べられる', () => {
    expect(similarRecurringPayments({ id: '', amount: 1590, dayOfMonth: 5 }, [NETFLIX])).toEqual([NETFLIX]);
  });
});
