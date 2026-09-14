import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  DUPLICATE_THRESHOLD,
  duplicateKey,
  duplicatesInvolving,
  findDuplicateReceipts,
  findDuplicates,
  isNotDuplicate,
  markNotDuplicate,
  scoreDuplicate,
} from '../duplicate';
import type { Receipt, Transaction } from '../types';

function txn(partial: Partial<Transaction> & { id: string; date: string; amount: number; rawMerchant: string }): Transaction {
  return {
    merchant: partial.rawMerchant,
    source: 'credit',
    sourceLabel: '楽天カード',
    splits: [{ id: `${partial.id}-1`, amount: partial.amount, categoryId: 'food', origin: 'rule' }],
    needsDetail: false,
    ...partial,
  };
}

function receipt(partial: Partial<Receipt> & { id: string; date: string; total: number; storeName: string }): Receipt {
  return { items: [], status: 'pending', ...partial };
}

/** 現金として保存したレシートの明細と、後から取り込んだカードの明細 */
const CASH = txn({
  id: 'cash1',
  date: '2026-09-01',
  amount: 1200,
  rawMerchant: 'セブン-イレブン品川駅前店',
  source: 'cash',
  sourceLabel: '現金',
  receiptId: 'r1',
});
const CARD = txn({ id: 'card1', date: '2026-09-03', amount: 1200, rawMerchant: 'セブン－イレブン品川' });

describe('findDuplicates', () => {
  it('現金レシートの明細と、後から取り込んだカード明細を候補に出す', () => {
    const pairs = findDuplicates([CASH, CARD]);
    expect(pairs).toHaveLength(1);
    expect(duplicateKey(pairs[0])).toBe('cash1:card1');
    expect(pairs[0].reasons).toContain('取り込み元が違う');
    expect(pairs[0].reasons).toContain('レシートが片方だけ');
  });

  it('金額が 1 円でも違えば候補に出ない', () => {
    expect(findDuplicates([CASH, { ...CARD, amount: 1201 }])).toEqual([]);
  });

  it('同じ金額の返金は支払いと組にならない', () => {
    const refund = txn({ id: 'refund1', date: '2026-09-02', amount: -1200, rawMerchant: 'セブン－イレブン品川' });
    expect(findDuplicates([CARD, refund])).toEqual([]);
  });

  it('日付が 5 日離れたら候補に出ない', () => {
    expect(findDuplicates([CASH, { ...CARD, date: '2026-09-06' }])).toEqual([]);
  });

  it('同じ日でも店が全く違えば候補に出ない', () => {
    const other = txn({ id: 'other1', date: '2026-09-03', amount: 1200, rawMerchant: 'ドン・キホーテ' });
    const gasStation = txn({ id: 'other2', date: '2026-09-04', amount: 1200, rawMerchant: 'エネオス環七' });
    expect(findDuplicates([other, gasStation])).toEqual([]);
  });

  it('「重複ではない」と印を付けた組は次から出ない', () => {
    const [a, b] = markNotDuplicate(CASH, CARD);
    expect(findDuplicates([a, b])).toEqual([]);
  });

  it('印は片側だけ残っていても効く', () => {
    const [a] = markNotDuplicate(CASH, CARD);
    expect(findDuplicates([a, CARD])).toEqual([]);
    expect(findDuplicates([CASH, { ...CARD, notDuplicateOf: [CASH.id] }])).toEqual([]);
  });

  it('点数の高い順に並ぶ', () => {
    const near = txn({ id: 'card2', date: '2026-09-04', amount: 1200, rawMerchant: 'セブン－イレブン品川' });
    const pairs = findDuplicates([CASH, CARD, near]);
    expect(pairs.length).toBeGreaterThan(1);
    for (let index = 1; index < pairs.length; index += 1) {
      expect(pairs[index - 1].score).toBeGreaterThanOrEqual(pairs[index].score);
    }
  });

  it('金額でバケツに分けるので、関係ない明細が増えても組は変わらない', () => {
    const noise = Array.from({ length: 50 }, (_, index) =>
      txn({ id: `n${index}`, date: '2026-09-02', amount: 500 + index, rawMerchant: `店${index}` }),
    );
    expect(findDuplicates([...noise, CASH, CARD])).toHaveLength(1);
  });
});

describe('scoreDuplicate', () => {
  it('同じ日・同じ店・取り込み元違いは高く付く', () => {
    const a = txn({ id: 'a', date: '2026-09-01', amount: 800, rawMerchant: 'ローソン五反田' });
    const b = txn({ id: 'b', date: '2026-09-01', amount: 800, rawMerchant: 'ローソン五反田', source: 'paypay', sourceLabel: 'PayPay' });
    const pair = scoreDuplicate(a, b);
    expect(pair.score).toBe(100);
    expect(pair.reasons).toEqual(['同じ日', '店名が同じ', '取り込み元が違う']);
  });

  it('金額の一致は必須なので点には入れない', () => {
    const a = txn({ id: 'a', date: '2026-09-01', amount: 800, rawMerchant: 'ローソン' });
    expect(scoreDuplicate(a, { ...a, id: 'b' }).score).toBe(scoreDuplicate({ ...a, amount: 99 }, { ...a, id: 'b', amount: 99 }).score);
  });
});

describe('markNotDuplicate', () => {
  it('両側に相手の ID を入れる', () => {
    const [a, b] = markNotDuplicate(CASH, CARD);
    expect(a.notDuplicateOf).toEqual(['card1']);
    expect(b.notDuplicateOf).toEqual(['cash1']);
    expect(isNotDuplicate(a, b)).toBe(true);
  });

  it('二度押しても増えない', () => {
    const [once, twice] = markNotDuplicate(...markNotDuplicate(CASH, CARD));
    expect(once.notDuplicateOf).toEqual(['card1']);
    expect(twice.notDuplicateOf).toEqual(['cash1']);
  });

  it('元の明細は書き換えない', () => {
    markNotDuplicate(CASH, CARD);
    expect(CASH.notDuplicateOf).toBeUndefined();
  });
});

describe('duplicatesInvolving', () => {
  it('指定した明細が絡む組だけ残す', () => {
    const pairs = findDuplicates([CASH, CARD]);
    expect(duplicatesInvolving(pairs, ['card1'])).toHaveLength(1);
    expect(duplicatesInvolving(pairs, ['よその明細'])).toEqual([]);
  });
});

describe('findDuplicateReceipts', () => {
  const first = receipt({
    id: 'r1',
    date: '2026-09-01',
    total: 1200,
    storeName: 'セブン-イレブン品川駅前店',
    items: [{ name: 'おにぎり', amount: 700 }, { name: 'お茶', amount: 500 }],
  });

  it('同じレシートを 2 回撮ったものを拾う', () => {
    const second = receipt({ ...first, id: 'r2' });
    const pairs = findDuplicateReceipts([first, second]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].reasons).toContain('品目まで同じ');
  });

  it('合計が違えば拾わない', () => {
    expect(findDuplicateReceipts([first, receipt({ ...first, id: 'r2', total: 1300 })])).toEqual([]);
  });

  it('捨てたレシートは相手にしない', () => {
    expect(findDuplicateReceipts([first, receipt({ ...first, id: 'r2', status: 'discarded' })])).toEqual([]);
  });

  it('同じ店の別の日の買い物は拾わない', () => {
    expect(findDuplicateReceipts([first, receipt({ ...first, id: 'r2', date: '2026-09-20' })])).toEqual([]);
  });
});

describe('プロパティ', () => {
  const day = fc.integer({ min: 1, max: 28 }).map((value) => `2026-09-${String(value).padStart(2, '0')}`);
  const merchant = fc.string({ minLength: 1, maxLength: 20 });
  const amount = fc.integer({ min: -500_000, max: 500_000 });

  it('同じ内容の明細が 2 件あれば必ず候補に出る', () => {
    fc.assert(
      fc.property(day, amount, merchant, (date, value, rawMerchant) => {
        const a = txn({ id: 'a', date, amount: value, rawMerchant });
        const pairs = findDuplicates([a, { ...a, id: 'b', splits: [{ ...a.splits[0], id: 'b-1' }] }]);
        expect(pairs).toHaveLength(1);
        expect(pairs[0].score).toBeGreaterThanOrEqual(DUPLICATE_THRESHOLD);
      }),
    );
  });

  it('金額が違えば、他が全部同じでも候補に出ない', () => {
    fc.assert(
      fc.property(day, amount, amount, merchant, (date, left, right, rawMerchant) => {
        fc.pre(left !== right);
        const a = txn({ id: 'a', date, amount: left, rawMerchant });
        const b = txn({ id: 'b', date, amount: right, rawMerchant, splits: [{ id: 'b-1', amount: right, categoryId: 'food', origin: 'rule' }] });
        expect(findDuplicates([a, b])).toEqual([]);
      }),
    );
  });

  it('渡す順を入れ替えても同じ組が出る', () => {
    fc.assert(
      fc.property(day, day, amount, merchant, merchant, (leftDate, rightDate, value, leftName, rightName) => {
        const a = txn({ id: 'a', date: leftDate, amount: value, rawMerchant: leftName });
        const b = txn({ id: 'b', date: rightDate, amount: value, rawMerchant: rightName });
        expect(findDuplicates([a, b]).map(duplicateKey)).toEqual(findDuplicates([b, a]).map(duplicateKey));
      }),
    );
  });
});
