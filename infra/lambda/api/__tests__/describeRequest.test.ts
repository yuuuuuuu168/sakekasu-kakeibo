import { beforeAll, describe, expect, it } from 'vitest';

let describeRequest: typeof import('../index')['describeRequest'];
let LOGGED_TRANSACTIONS: number;

beforeAll(async () => {
  process.env.TABLE_NAME = 'test-table';
  process.env.RECEIPT_BUCKET = 'test-bucket';
  ({ describeRequest, LOGGED_TRANSACTIONS } = await import('../index'));
});

const TXN = {
  id: 't1',
  date: '2026-09-01',
  amount: 1300,
  rawMerchant: 'イトーヨーカドー',
  receiptId: 'r1',
  splits: [
    { id: 's1', name: 'ティッシュ', amount: 1000, categoryId: 'daily-consumables' },
    { id: 's2', name: 'おにぎり', amount: 500, categoryId: 'food-deli' },
    { id: 's3', name: 'クーポン値引', amount: -200, categoryId: 'discount' },
  ],
};

describe('describeRequest', () => {
  it('明細は件数・カテゴリ別の行数と、品目名・カテゴリ・金額の中身を出す', () => {
    expect(describeRequest('PUT', ['transactions'], { transactions: [TXN] })).toEqual({
      明細: 1,
      内訳のカテゴリ: { 'daily-consumables': 1, 'food-deli': 1, discount: 1, 負の行: 1 },
      中身: [
        {
          id: 't1',
          日付: '2026-09-01',
          店: 'イトーヨーカドー',
          金額: 1300,
          レシート: 'r1',
          内訳: [
            ['ティッシュ', 'daily-consumables', 1000],
            ['おにぎり', 'food-deli', 500],
            ['クーポン値引', 'discount', -200],
          ],
        },
      ],
    });
  });

  it('1 件ずつの保存は、パスの ID で中身を出す', () => {
    const { id: _id, ...body } = TXN;
    const logged = describeRequest('PUT', ['transactions', 't9'], body);
    expect(logged.明細).toBe(1);
    expect((logged.中身 as { id: string }[])[0].id).toBe('t9');
  });

  it('取り込みのように件数が多いときは、中身を先頭だけにして省いた数を残す', () => {
    const many = Array.from({ length: LOGGED_TRANSACTIONS + 3 }, (_, index) => ({ ...TXN, id: `t${index}` }));
    const logged = describeRequest('PUT', ['transactions'], { transactions: many });
    expect(logged.明細).toBe(LOGGED_TRANSACTIONS + 3);
    expect(logged.中身).toHaveLength(LOGGED_TRANSACTIONS);
    expect(logged.省いた明細).toBe(3);
    expect((logged.内訳のカテゴリ as Record<string, number>).discount).toBe(LOGGED_TRANSACTIONS + 3);
  });

  it('レシートは店・日付・合計と品目を出す', () => {
    const receipt = { storeName: 'ローソン', date: '2026-09-02', total: 300, items: [{ name: 'からあげ 値引', amount: -50, categoryId: 'discount' }] };
    expect(describeRequest('PUT', ['receipts', 'r2'], receipt)).toEqual({
      レシート: 'r2',
      店: 'ローソン',
      日付: '2026-09-02',
      合計: 300,
      品目のカテゴリ: { discount: 1, 負の行: 1 },
      品目: [['からあげ 値引', 'discount', -50]],
    });
  });

  it('読み出しや削除は中身を付けない', () => {
    expect(describeRequest('GET', ['snapshot'], {})).toEqual({});
    expect(describeRequest('DELETE', ['transactions', 't1'], {})).toEqual({});
  });
});
