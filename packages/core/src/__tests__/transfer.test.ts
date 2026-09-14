import { describe, expect, it } from 'vitest';
import { SEED_CATEGORIES, TRANSFER_ID } from '../categories';
import { allRules, classify } from '../rules';
import { aggregateMonth } from '../budget';
import { buildMonthlyReport, topMerchants } from '../report';
import { asTransfer, findMisfiledTransfers, isTransfer, spendingOnly, transferTotal } from '../transfer';
import type { Transaction } from '../types';

function txn(partial: Partial<Transaction> & { id: string; date: string; amount: number; rawMerchant: string }): Transaction {
  const categoryId = partial.splits?.[0]?.categoryId ?? 'food';
  return {
    merchant: partial.rawMerchant,
    source: 'credit',
    sourceLabel: 'ビューカード',
    splits: [{ id: `${partial.id}-1`, amount: partial.amount, categoryId, origin: 'rule' }],
    needsDetail: false,
    ...partial,
  };
}

function transfer(id: string, date: string, amount: number, rawMerchant: string): Transaction {
  return txn({ id, date, amount, rawMerchant, splits: [{ id: `${id}-1`, amount, categoryId: TRANSFER_ID, origin: 'rule' }] });
}

const RULES = allRules([]);

describe('チャージのルール', () => {
  it('JRE カードの Suica チャージを交通費ではなく振替にする', () => {
    expect(classify('モバイルSuica', RULES).categoryId).toBe(TRANSFER_ID);
    expect(classify('モバイルSuica オートチャージ', RULES).categoryId).toBe(TRANSFER_ID);
    expect(classify('ビューカード モバイルSuicaチャージ', RULES).categoryId).toBe(TRANSFER_ID);
  });

  it('PayPay のチャージも振替にする', () => {
    expect(classify('ペイペイ チャージ', RULES).categoryId).toBe(TRANSFER_ID);
    expect(classify('PayPayチャージ', RULES).categoryId).toBe(TRANSFER_ID);
  });

  it('モバイル PASMO のチャージも同じ', () => {
    expect(classify('モバイルPASMO', RULES).categoryId).toBe(TRANSFER_ID);
  });

  it('Suica で実際に乗った分は交通費のまま', () => {
    expect(classify('JR東日本 品川', RULES).categoryId).toBe('transport');
    expect(classify('Suica 物販', RULES).categoryId).toBe('transport');
  });

  it('付け替えて覚えさせたルールはチャージのルールより強い', () => {
    const learned = { id: 'learned-チャージスポット', pattern: 'チャージスポット', matchType: 'equals' as const, categoryId: 'hobby', priority: 100 };
    expect(classify('チャージスポット', allRules([learned])).categoryId).toBe('hobby');
  });
});

describe('isTransfer / spendingOnly', () => {
  const charge = transfer('t1', '2026-09-01', 3000, 'モバイルSuica');
  const lunch = txn({ id: 't2', date: '2026-09-01', amount: 900, rawMerchant: '大戸屋' });

  it('内訳が全部チャージなら振替', () => {
    expect(isTransfer(charge)).toBe(true);
    expect(isTransfer(lunch)).toBe(false);
  });

  it('振替を落とした明細を返す', () => {
    expect(spendingOnly([charge, lunch]).map((item) => item.id)).toEqual(['t2']);
  });

  it('振替の合計を出す', () => {
    expect(transferTotal([charge, lunch])).toBe(3000);
  });
});

describe('aggregateMonth', () => {
  const transactions = [
    transfer('t1', '2026-09-01', 3000, 'モバイルSuica'),
    txn({ id: 't2', date: '2026-09-02', amount: 900, rawMerchant: '大戸屋' }),
    txn({ id: 't3', date: '2026-09-03', amount: 600, rawMerchant: 'JR東日本', splits: [{ id: 't3-1', amount: 600, categoryId: 'transport', origin: 'rule' }] }),
  ];
  const summary = aggregateMonth({
    month: '2026-09',
    transactions,
    categories: SEED_CATEGORIES,
    today: '2026-09-30',
  });

  it('チャージを支出の合計に入れない', () => {
    expect(summary.total).toBe(1500);
    expect(summary.transactionCount).toBe(2);
  });

  it('外した分は別に持って画面に出せるようにする', () => {
    expect(summary.transferTotal).toBe(3000);
    expect(summary.transferCount).toBe(1);
  });

  it('チャージで交通費が水増しされない', () => {
    expect(summary.categories.find((row) => row.categoryId === 'transport')?.actual).toBe(600);
  });

  it('振替はカテゴリ別の行に出さない', () => {
    expect(summary.categories.some((row) => row.categoryId === TRANSFER_ID)).toBe(false);
  });

  it('振替に上限が入っていても、上限の合計には数えない', () => {
    const withLimit = aggregateMonth({
      month: '2026-09',
      transactions,
      categories: SEED_CATEGORIES,
      budget: { month: '2026-09', limits: { food: 20000, [TRANSFER_ID]: 50000 } },
      today: '2026-09-30',
    });
    expect(withLimit.limitTotal).toBe(20000);
    expect(withLimit.categories.some((row) => row.categoryId === TRANSFER_ID)).toBe(false);
  });

  it('内訳の一部だけを振替に割っても、その分は集計から落ちる', () => {
    const mixed = txn({
      id: 't4',
      date: '2026-09-04',
      amount: 5000,
      rawMerchant: 'ビューカード',
      splits: [
        { id: 't4-1', amount: 3000, categoryId: TRANSFER_ID, origin: 'manual' },
        { id: 't4-2', amount: 2000, categoryId: 'transport', origin: 'manual' },
      ],
    });
    const withMixed = aggregateMonth({ month: '2026-09', transactions: [mixed], categories: SEED_CATEGORIES, today: '2026-09-30' });
    expect(withMixed.total).toBe(2000);
    expect(withMixed.transferTotal).toBe(3000);
  });
});

describe('レポート', () => {
  const transactions = [
    transfer('t1', '2026-09-01', 3000, 'モバイルSuica'),
    txn({ id: 't2', date: '2026-09-02', amount: 900, rawMerchant: '大戸屋' }),
    transfer('t0', '2026-08-01', 5000, 'モバイルSuica'),
    txn({ id: 't9', date: '2026-08-02', amount: 900, rawMerchant: '大戸屋' }),
  ];

  it('よく使った店にチャージを出さない', () => {
    expect(topMerchants(transactions).map((row) => row.rawMerchant)).toEqual(['大戸屋']);
  });

  it('前月との比較も支出どうしで見る', () => {
    const report = buildMonthlyReport({ month: '2026-09', transactions, categories: SEED_CATEGORIES, generatedAt: '2026-10-01T00:00:00Z' });
    expect(report.total).toBe(900);
    expect(report.previousTotal).toBe(900);
    expect(report.deltaFromPrevious).toBe(0);
  });
});

describe('findMisfiledTransfers / asTransfer', () => {
  // チャージのルールを足す前に取り込まれ、交通費のまま残っている Suica チャージ
  const stale = txn({
    id: 'old1',
    date: '2026-08-10',
    amount: 3000,
    rawMerchant: 'モバイルSuica',
    splits: [{ id: 'old1-1', amount: 3000, categoryId: 'transport', origin: 'rule' }],
  });

  it('今のルールならチャージになる明細を見つける', () => {
    expect(findMisfiledTransfers([stale], RULES).map((item) => item.id)).toEqual(['old1']);
  });

  it('すでに振替になっているものは出さない', () => {
    expect(findMisfiledTransfers([transfer('t1', '2026-09-01', 3000, 'モバイルSuica')], RULES)).toEqual([]);
  });

  it('チャージでない明細は出さない', () => {
    expect(findMisfiledTransfers([txn({ id: 't2', date: '2026-09-02', amount: 900, rawMerchant: '大戸屋' })], RULES)).toEqual([]);
  });

  it('振替にすると内訳が 1 行になり、合計は金額に一致する', () => {
    const fixed = asTransfer(stale);
    expect(fixed.splits).toEqual([{ id: 'old1-1', amount: 3000, categoryId: TRANSFER_ID, origin: 'manual' }]);
    expect(fixed.splits.reduce((sum, split) => sum + split.amount, 0)).toBe(fixed.amount);
    expect(isTransfer(fixed)).toBe(true);
  });
});
