import { beforeAll, describe, expect, it } from 'vitest';

let assertTransaction: typeof import('../index')['assertTransaction'];

const VALID = {
  id: 't1',
  date: '2026-09-01',
  amount: 1200,
  splits: [
    { id: 's1', amount: 800, categoryId: 'food', origin: 'receipt' },
    { id: 's2', amount: 400, categoryId: 'daily', origin: 'receipt' },
  ],
};

beforeAll(async () => {
  process.env.TABLE_NAME = 'test-table';
  process.env.RECEIPT_BUCKET = 'test-bucket';
  assertTransaction = (await import('../index')).assertTransaction;
});

describe('assertTransaction', () => {
  it('内訳の合計が金額に一致していれば通す', () => {
    expect(() => assertTransaction(VALID)).not.toThrow();
  });

  it('内訳の合計が金額と合わなければ保存させない', () => {
    expect(() => assertTransaction({ ...VALID, amount: 1300 })).toThrow(/合いません/);
  });

  it('日付の形が違えば断る', () => {
    expect(() => assertTransaction({ ...VALID, date: '2026/09/01' })).toThrow(/YYYY-MM-DD/);
  });

  it('金額が整数でなければ断る', () => {
    expect(() => assertTransaction({ ...VALID, amount: 1200.5 })).toThrow(/整数/);
  });

  it('本文の pk / sk は返さない（キーは sub から組み立てる）', () => {
    const result = assertTransaction({ ...VALID, pk: 'USER#someone-else', sk: 'CONFIG#categories' });
    expect(result).not.toHaveProperty('pk');
    expect(result).not.toHaveProperty('sk');
    expect(result.id).toBe('t1');
  });

  it('内訳が無ければ断る', () => {
    expect(() => assertTransaction({ ...VALID, splits: [] })).toThrow(/内訳がありません/);
  });

  it('内訳にカテゴリが無ければ断る', () => {
    expect(() => assertTransaction({ ...VALID, splits: [{ id: 's1', amount: 1200, origin: 'manual' }] })).toThrow(
      /カテゴリがありません/,
    );
  });

  it('明細でないものを断る', () => {
    expect(() => assertTransaction(null)).toThrow(/形が違います/);
    expect(() => assertTransaction({ date: '2026-09-01' })).toThrow(/id がありません/);
  });
});
