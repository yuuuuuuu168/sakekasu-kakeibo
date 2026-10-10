import { describe, expect, it } from 'vitest';
import { RECEIPT_PAYMENT_METHODS, SOURCE_LABELS, hasImportableStatement, toPaymentMethod } from '../payment';

describe('支払い方法', () => {
  it('レシートから選べるのは現金・PayPay・クレジットカード・Suica・不明', () => {
    expect(RECEIPT_PAYMENT_METHODS.map((method) => SOURCE_LABELS[method])).toEqual([
      '現金',
      'PayPay',
      'クレジットカード',
      'Suica',
      '不明',
    ]);
  });

  it('OCR の答えは印字から決められるものだけ受け取る', () => {
    expect(toPaymentMethod('suica')).toBe('suica');
    expect(toPaymentMethod('credit')).toBe('credit');
    // 「不明」は人が選ぶもので、OCR が返しても初期値にしない
    expect(toPaymentMethod('unknown')).toBeUndefined();
    expect(toPaymentMethod('manual')).toBeUndefined();
    expect(toPaymentMethod(null)).toBeUndefined();
    expect(toPaymentMethod('交通系')).toBeUndefined();
  });

  it('利用明細を取り込めるのはカードと PayPay だけ', () => {
    expect(RECEIPT_PAYMENT_METHODS.filter(hasImportableStatement)).toEqual(['paypay', 'credit']);
  });
});
