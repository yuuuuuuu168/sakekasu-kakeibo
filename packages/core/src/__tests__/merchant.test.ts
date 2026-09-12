import { describe, expect, it } from 'vitest';
import { merchantSimilarity, normalizeMerchant } from '../merchant';

describe('normalizeMerchant', () => {
  it('半角カナと全角英数を寄せる', () => {
    expect(normalizeMerchant('ｾﾌﾞﾝ-ｲﾚﾌﾞﾝ')).toBe('セブンイレブン');
    expect(normalizeMerchant('ＡＭＡＺＯＮ．ＣＯ．ＪＰ')).toBe('AMAZONCOJP');
  });

  it('Amazon の注文 ID を落とす', () => {
    expect(normalizeMerchant('AMAZON.CO.JP*M12AB3CD4')).toBe('AMAZONCOJP');
  });

  it('店舗番号や伝票番号を落とす', () => {
    expect(normalizeMerchant('セブンイレブン 12345')).toBe('セブンイレブン');
    expect(normalizeMerchant('ローソン 品川店 7')).toBe('ローソン品川店');
  });

  it('長音記号は残す', () => {
    expect(normalizeMerchant('コーヒー・ショップ')).toBe('コーヒーショップ');
  });

  it('空文字と空白だけの入力で落ちない', () => {
    expect(normalizeMerchant('')).toBe('');
    expect(normalizeMerchant('   ')).toBe('');
  });
});

describe('merchantSimilarity', () => {
  it('同じ店名は 1', () => {
    expect(merchantSimilarity('セブンイレブン', 'ｾﾌﾞﾝｲﾚﾌﾞﾝ')).toBe(1);
  });

  it('一方が他方を含めば 0.5 以上', () => {
    expect(merchantSimilarity('セブンイレブン', 'セブンイレブン品川駅前店')).toBeGreaterThanOrEqual(0.5);
  });

  it('別の店は 0', () => {
    expect(merchantSimilarity('セブンイレブン', 'マツモトキヨシ')).toBe(0);
  });

  it('片方が空なら 0', () => {
    expect(merchantSimilarity('', 'ローソン')).toBe(0);
  });
});
