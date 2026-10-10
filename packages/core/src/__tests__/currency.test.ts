import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  DEFAULT_USD_RATE,
  convertDisplayed,
  formatMoney,
  fromMinor,
  impliedRate,
  latestUsdRate,
  receiptYenTotal,
  toMinor,
} from '../currency';
import { findDuplicateReceipts } from '../duplicate';
import { autoMatch, findCandidates } from '../receipt/match';
import { transactionFromReceipt } from '../receipt/register';
import { applyReceipt, splitsFromReceipt, sumSplits } from '../receipt/split';
import type { Receipt, Transaction } from '../types';

/** $12.34 のレシート。金額はセント */
const USD_RECEIPT: Receipt = {
  id: 'r-usd',
  storeName: 'Starbucks',
  date: '2026-10-03',
  total: 1234,
  currency: 'USD',
  exchangeRate: 150,
  items: [
    { name: 'Latte', amount: 595, categoryId: 'food-cafe' },
    { name: 'Croissant', amount: 525, categoryId: 'food-cafe' },
  ],
  status: 'pending',
};

function card(partial: Partial<Transaction> & { id: string; amount: number }): Transaction {
  return {
    date: '2026-10-03',
    rawMerchant: 'STARBUCKS SEATTLE',
    merchant: 'STARBUCKS SEATTLE',
    source: 'credit',
    sourceLabel: '楽天カード',
    splits: [{ id: `${partial.id}-1`, amount: partial.amount, categoryId: 'food', origin: 'rule' }],
    needsDetail: true,
    ...partial,
  };
}

describe('金額の単位', () => {
  it('ドルはセントの整数で持ち、円はそのまま', () => {
    expect(toMinor(12.34, 'USD')).toBe(1234);
    // 0.1 + 0.2 のような浮動小数のずれを丸めで吸収する
    expect(toMinor(0.29, 'USD')).toBe(29);
    expect(toMinor(1200, 'JPY')).toBe(1200);
    expect(fromMinor(1234, 'USD')).toBe(12.34);
  });

  it('通貨ごとの書き方で出す', () => {
    expect(formatMoney(1234, 'USD')).toBe('$12.34');
    expect(formatMoney(-50, 'USD')).toBe('-$0.50');
    expect(formatMoney(123456, 'USD')).toBe('$1,234.56');
    expect(formatMoney(1200)).toBe('¥1,200');
  });

  it('通貨を切り替えても、見えている数は変えない', () => {
    expect(convertDisplayed(12, 'JPY', 'USD')).toBe(1200);
    expect(convertDisplayed(1234, 'USD', 'JPY')).toBe(12);
  });
});

describe('レート', () => {
  it('レシートのレートで円に直す。無ければ既定のレート', () => {
    expect(receiptYenTotal(USD_RECEIPT)).toBe(1851);
    expect(receiptYenTotal({ ...USD_RECEIPT, exchangeRate: undefined })).toBe(Math.round(12.34 * DEFAULT_USD_RATE));
    expect(receiptYenTotal({ total: 1200 })).toBe(1200);
  });

  it('請求額から実際のレートを割り戻す', () => {
    expect(impliedRate(1890, 1234)).toBe(153.16);
    expect(impliedRate(1890, 0)).toBeUndefined();
  });

  it('日付の新しいドルのレシートのレートを次の既定にする', () => {
    const receipts: Receipt[] = [
      { ...USD_RECEIPT, id: 'a', date: '2026-09-01', exchangeRate: 145 },
      { ...USD_RECEIPT, id: 'b', date: '2026-10-01', exchangeRate: 152.5 },
      { ...USD_RECEIPT, id: 'c', date: '2026-10-05', currency: undefined, exchangeRate: 999 },
    ];
    expect(latestUsdRate(receipts)).toBe(152.5);
    expect(latestUsdRate([])).toBe(DEFAULT_USD_RATE);
  });
});

describe('ドルのレシートと明細', () => {
  it('レシートから明細を作ると、金額は円で、ドルは控えに残る', () => {
    const txn = transactionFromReceipt(USD_RECEIPT, 'cash');
    expect(txn.amount).toBe(1851);
    expect(txn.foreign).toEqual({ currency: 'USD', amount: 1234 });
    expect(sumSplits(txn.splits)).toBe(1851);
    // 品目のセントの比で円を配る
    expect(txn.splits.map((split) => split.amount)).toEqual([983, 868]);
  });

  it('円に直したレシートで作り直すと、ドルの控えは消える', () => {
    const before = transactionFromReceipt(USD_RECEIPT, 'cash');
    const after = transactionFromReceipt({ ...USD_RECEIPT, currency: undefined, total: 1800, items: [] }, 'cash', before);
    expect(after.foreign).toBeUndefined();
    expect(after.id).toBe(before.id);
  });

  it('カードの明細に当てると、請求額の円で内訳を作る', () => {
    const txn = applyReceipt(card({ id: 'c1', amount: 1890 }), USD_RECEIPT);
    expect(sumSplits(txn.splits)).toBe(1890);
    expect(txn.foreign).toEqual({ currency: 'USD', amount: 1234 });
  });

  it('換算額に近い円の明細を候補にする', () => {
    const candidates = findCandidates(USD_RECEIPT, [
      card({ id: 'near', amount: 1890 }),
      card({ id: 'far', amount: 2100 }),
      card({ id: 'cents', amount: 1234 }),
    ]);
    expect(candidates.map((candidate) => candidate.txn.id)).toEqual(['near']);
    expect(candidates[0].reasons[0]).toBe('換算で近い');
  });

  it('円のレシートは、これまで通り金額の一致を求める', () => {
    const yen: Receipt = { ...USD_RECEIPT, currency: undefined, exchangeRate: undefined, total: 1890 };
    expect(findCandidates(yen, [card({ id: 'a', amount: 1890 }), card({ id: 'b', amount: 1891 })]).map((c) => c.txn.id)).toEqual(['a']);
  });

  it('同じ日・同じ店なら、ドルのレシートでも自動で当てる', () => {
    const matched = autoMatch(findCandidates({ ...USD_RECEIPT, storeName: 'STARBUCKS' }, [card({ id: 'a', amount: 1890 })]));
    expect(matched?.id).toBe('a');
  });

  it('1,200 円と 12.00 ドルは同じレシートと見ない', () => {
    const yen: Receipt = { ...USD_RECEIPT, id: 'yen', currency: undefined, exchangeRate: undefined, total: 1200, items: [] };
    const usd: Receipt = { ...USD_RECEIPT, id: 'usd', total: 1200, items: [] };
    expect(findDuplicateReceipts([yen, usd])).toEqual([]);
    expect(findDuplicateReceipts([usd, { ...usd, id: 'usd-2' }])).toHaveLength(1);
  });

  it('ドルの品目から作った内訳の合計は、どんなレートでも円の金額に一致する', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -5_000, max: 50_000 }), { minLength: 1, maxLength: 12 }),
        fc.integer({ min: 1, max: 5_000_000 }),
        (cents, yen) => {
          const receipt: Receipt = {
            ...USD_RECEIPT,
            total: cents.reduce((sum, value) => sum + value, 0),
            items: cents.map((amount, index) => ({ name: `item-${index}`, amount })),
          };
          expect(sumSplits(splitsFromReceipt(receipt, yen))).toBe(yen);
        },
      ),
    );
  });
});
