import { describe, expect, it } from 'vitest';
import { MAX_RECEIPT_ITEMS, assertLimits, assertMapping, assertReceipt } from '../validate';

const RECEIPT = {
  id: 'r1',
  storeName: 'Starbucks',
  date: '2026-09-01',
  total: 1234,
  items: [{ name: 'Latte', amount: 1234, categoryId: 'food-cafe', quantity: 1 }],
  status: 'cash',
  paidWith: 'credit',
  currency: 'USD',
  exchangeRate: 150.12,
  imageKey: 'receipts/user-1/2026-09-01/a.jpg',
  imageKeys: ['receipts/user-1/2026-09-01/a.jpg', 'receipts/user-1/2026-09-01/b.jpg'],
  txnId: 't1',
  createdAt: '2026-09-01T10:00:00.000Z',
  notDuplicateOf: ['r2'],
  warnings: ['合計を確かめてください'],
};

describe('assertReceipt', () => {
  it('画面が送る形を通し、id はパスの値にする。知らない欄も残す', () => {
    const saved = assertReceipt({ ...RECEIPT, id: 'other', pk: 'USER#x', sk: 'CONFIG#categories' }, 'r1', 'user-1');
    expect(saved).toMatchObject({ id: 'r1', notDuplicateOf: ['r2'], warnings: ['合計を確かめてください'] });
    expect(saved).not.toHaveProperty('pk');
    expect(saved).not.toHaveProperty('sk');
  });

  it('円のレシート（通貨・レート・写真なし）も通す', () => {
    const { currency: _c, exchangeRate: _r, imageKey: _k, imageKeys: _ks, paidWith: _p, txnId: _t, ...yen } = RECEIPT;
    expect(() => assertReceipt({ ...yen, status: 'pending' }, 'r1', 'user-1')).not.toThrow();
  });

  it.each([
    ['店名が無い', { storeName: undefined }, '店名'],
    ['日付が YYYY-MM-DD でない', { date: '' }, '日付'],
    ['合計が整数でない', { total: 12.5 }, '合計'],
    ['状態が違う', { status: 'paid' }, '状態'],
    ['品目が配列でない', { items: 'Latte' }, '品目の一覧'],
    ['品目の金額が文字列', { items: [{ name: 'Latte', amount: '1234' }] }, '金額'],
    ['品目に名前が無い', { items: [{ amount: 100 }] }, '名前'],
    ['通貨が違う', { currency: 'EUR' }, '通貨'],
    ['レートが 0', { exchangeRate: 0 }, 'レート'],
    ['支払い方法が違う', { paidWith: 'bitcoin' }, '支払い方法'],
  ])('%s なら 400', (_label, patch, message) => {
    expect(() => assertReceipt({ ...RECEIPT, ...patch }, 'r1', 'user-1')).toThrow(message);
  });

  it('品目が多すぎれば 400', () => {
    const items = Array.from({ length: MAX_RECEIPT_ITEMS + 1 }, () => ({ name: 'x', amount: 1 }));
    expect(() => assertReceipt({ ...RECEIPT, items }, 'r1', 'user-1')).toThrow(`${MAX_RECEIPT_ITEMS} 件まで`);
  });

  it('ほかの利用者の置き場所の写真は受け取らない', () => {
    expect(() => assertReceipt({ ...RECEIPT, imageKey: 'receipts/user-2/a.jpg' }, 'r1', 'user-1')).toThrow('置き場所');
    expect(() =>
      assertReceipt({ ...RECEIPT, imageKeys: ['receipts/user-1/a.jpg', 'receipts/user-10/b.jpg'] }, 'r1', 'user-1'),
    ).toThrow('置き場所');
  });
});

describe('assertMapping', () => {
  const MAPPING = {
    sourceId: 'paypay',
    label: 'PayPay',
    source: 'paypay',
    mapping: { headerRowIndex: 0, date: 0, merchant: 1, amount: 2, refund: 3, sign: 'negative-expense' },
  };

  it('画面が送る形を通し、sourceId はパスの値にする', () => {
    expect(assertMapping({ ...MAPPING, sourceId: 'other' }, 'paypay')).toMatchObject({ sourceId: 'paypay', label: 'PayPay' });
  });

  it('見つからない列（-1）も通す', () => {
    expect(() => assertMapping({ ...MAPPING, mapping: { ...MAPPING.mapping, headerRowIndex: -1 } }, 'paypay')).not.toThrow();
  });

  it.each([
    ['表示名が無い', { label: undefined }, '表示名'],
    ['取り込み元が違う', { source: 'bank' }, '取り込み元'],
    ['列の対応が無い', { mapping: undefined }, 'がありません'],
    ['列の位置が文字列', { mapping: { ...MAPPING.mapping, date: '0' } }, 'date'],
    ['符号が違う', { mapping: { ...MAPPING.mapping, sign: 'plus' } }, '符号'],
  ])('%s なら 400', (_label, patch, message) => {
    expect(() => assertMapping({ ...MAPPING, ...patch }, 'paypay')).toThrow(message);
  });
});

describe('assertLimits', () => {
  it('0 以上の整数を通す', () => {
    expect(assertLimits({ food: 30000, daily: 0 })).toEqual({ food: 30000, daily: 0 });
    expect(assertLimits({})).toEqual({});
  });

  it.each([
    ['オブジェクトでない', null],
    ['配列', [1]],
    ['負の数', { food: -1 }],
    ['小数', { food: 1.5 }],
    ['文字列', { food: '3000' }],
  ])('%s なら 400', (_label, value) => {
    expect(() => assertLimits(value)).toThrow();
  });
});
