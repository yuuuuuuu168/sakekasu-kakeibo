import { describe, expect, it } from 'vitest';
import type { Receipt } from '@kakeibo/core';
import {
  currencyFields,
  draftFromReceipt,
  editedReceipt,
  imageFields,
  lacksRate,
  receiptFromDraft,
  removeItem,
  toReceiptItems,
  updateItem,
  withCurrency,
  yenHint,
  type Draft,
} from '../draft';

const DRAFT: Draft = {
  id: 'r-1',
  storeName: 'ローソン',
  date: '2026-09-01',
  total: 300,
  items: [
    { name: 'おにぎり', amount: 150, categoryId: 'food', categoryEdited: true },
    { name: 'お茶', amount: 150, categoryId: 'food' },
  ],
  currency: 'JPY',
  paidWith: 'suica',
  warnings: ['合計を確かめてください'],
};

const USD: Draft = { ...DRAFT, currency: 'USD', total: 1234, items: [{ name: 'Coffee', amount: 1234 }], exchangeRate: 150 };

describe('下書きの品目', () => {
  it('1 行だけ差し替え、ほかの行はそのまま', () => {
    const next = updateItem(DRAFT, 1, { amount: 200 });
    expect(next.items.map((item) => item.amount)).toEqual([150, 200]);
    expect(next.items[0]).toBe(DRAFT.items[0]);
  });

  it('1 行だけ消す', () => {
    expect(removeItem(DRAFT, 0).items.map((item) => item.name)).toEqual(['お茶']);
  });

  it('保存する品目からは、覚えるための印を落とす', () => {
    expect(toReceiptItems(DRAFT.items)[0]).toEqual({ name: 'おにぎり', amount: 150, categoryId: 'food' });
  });
});

describe('通貨', () => {
  it('円からドルに切り替えると、見えている数はそのままでセントに直し、レートが無ければ直近のものを入れる', () => {
    const next = withCurrency(DRAFT, 'USD', 151);
    expect(next.currency).toBe('USD');
    expect(next.total).toBe(30000);
    expect(next.items[0].amount).toBe(15000);
    expect(next.exchangeRate).toBe(151);
  });

  it('同じ通貨なら何も変えない', () => {
    expect(withCurrency(DRAFT, 'JPY', 151)).toBe(DRAFT);
  });

  it('ドルでレートが無ければ円に直せない', () => {
    expect(lacksRate({ ...USD, exchangeRate: undefined })).toBe(true);
    expect(lacksRate(USD)).toBe(false);
    expect(lacksRate(DRAFT)).toBe(false);
  });

  it('円のレシートには通貨の欄を持たせず、ドルは当てた明細の請求額から割り戻したレートを残す', () => {
    expect(currencyFields(DRAFT)).toEqual({});
    expect(currencyFields(USD)).toEqual({ currency: 'USD', exchangeRate: 150 });
    expect(currencyFields(USD, 1900).exchangeRate).toBeCloseTo(153.97, 2);
  });

  it('ドルでレートがあるときだけ、円に直した額を添える', () => {
    expect(yenHint(USD)).toBe('約 ¥1,851');
    expect(yenHint(DRAFT)).toBeUndefined();
    expect(yenHint({ ...USD, exchangeRate: undefined })).toBeUndefined();
  });
});

describe('写真のキー', () => {
  it('1 枚なら imageKey だけ、分けて撮ったときは imageKeys に全部', () => {
    expect(imageFields([])).toEqual({});
    expect(imageFields(['a'])).toEqual({ imageKey: 'a' });
    expect(imageFields(['a', 'b'])).toEqual({ imageKey: 'a', imageKeys: ['a', 'b'] });
  });
});

describe('レシートの組み立て', () => {
  const createdAt = '2026-09-01T10:00:00.000Z';

  it('明細を選んで当てると matched で、明細の ID を持つ。支払い方法は持たない', () => {
    const receipt = receiptFromDraft(DRAFT, { asPayment: false, txnId: 't1', createdAt });
    expect(receipt).toMatchObject({ status: 'matched', txnId: 't1', createdAt });
    expect(receipt).not.toHaveProperty('paidWith');
    expect(receipt.items[0]).not.toHaveProperty('categoryEdited');
  });

  it('明細を選ばなければ pending', () => {
    expect(receiptFromDraft(DRAFT, { asPayment: false, createdAt }).status).toBe('pending');
  });

  it('支払い方法で登録すると cash で、明細を選んでいても ID は持たない', () => {
    const receipt = receiptFromDraft(DRAFT, { asPayment: true, txnId: 't1', createdAt });
    expect(receipt).toMatchObject({ status: 'cash', paidWith: 'suica' });
    expect(receipt).not.toHaveProperty('txnId');
  });

  it('直したときは、つながりを開いた時点のままにし、円に戻したらドルの欄を消す', () => {
    const opened: Receipt = { ...receiptFromDraft(USD, { asPayment: true, createdAt }), id: 'r-1' };
    expect(opened).toMatchObject({ currency: 'USD', exchangeRate: 150 });

    const back = editedReceipt(opened, { ...draftFromReceipt(opened), currency: 'JPY', total: 1850, paidWith: 'cash' });
    expect(back).toMatchObject({ id: 'r-1', status: 'cash', paidWith: 'cash', createdAt, total: 1850 });
    expect(back).not.toHaveProperty('currency');
    expect(back).not.toHaveProperty('exchangeRate');
  });

  it('保存済みのレシートは、そのまま下書きに戻せる', () => {
    const saved = receiptFromDraft(DRAFT, { asPayment: true, createdAt });
    expect(draftFromReceipt(saved)).toMatchObject({ id: 'r-1', storeName: 'ローソン', total: 300, currency: 'JPY', paidWith: 'suica' });
  });
});
