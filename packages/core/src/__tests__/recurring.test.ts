import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  occurrenceIndex,
  occurrenceOfMonth,
  recurringOccurrences,
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
