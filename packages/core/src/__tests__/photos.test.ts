import { describe, expect, it } from 'vitest';
import { RECEIPT_IMAGE_TYPES, isReceiptImageType } from '../receipt/photos';

describe('isReceiptImageType', () => {
  it('JPEG・PNG・WebP だけを受け取る', () => {
    expect(Object.keys(RECEIPT_IMAGE_TYPES)).toEqual(['image/jpeg', 'image/png', 'image/webp']);
    for (const type of Object.keys(RECEIPT_IMAGE_TYPES)) expect(isReceiptImageType(type)).toBe(true);
  });

  it('SVG は image/ で始まっても受け取らない。中にスクリプトを持てるため', () => {
    expect(isReceiptImageType('image/svg+xml')).toBe(false);
  });

  it('他の画像形式や画像でないもの、大文字や付け足しのあるものも受け取らない', () => {
    for (const type of ['image/heic', 'image/gif', 'text/html', 'application/pdf', '', 'IMAGE/JPEG', 'image/jpeg; charset=utf-8', 'toString', '__proto__']) {
      expect(isReceiptImageType(type)).toBe(false);
    }
  });
});
