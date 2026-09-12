import { describe, expect, it } from 'vitest';
import { BUILTIN_RULES, allRules, classify, learnRule, pickRule } from '../rules';
import { UNCATEGORIZED_ID } from '../categories';

describe('classify', () => {
  it('コンビニは食費だが内訳待ちにする', () => {
    const result = classify('ｾﾌﾞﾝ-ｲﾚﾌﾞﾝ 品川店', BUILTIN_RULES);
    expect(result.categoryId).toBe('food');
    expect(result.ambiguous).toBe(true);
  });

  it('長いパターンが短いパターンに勝つ', () => {
    expect(classify('AMAZON.CO.JP*M12AB3', BUILTIN_RULES).categoryId).toBe('daily');
    expect(classify('AMAZON PRIME*JP', BUILTIN_RULES).categoryId).toBe('subscription');
    expect(classify('UBER EATS JAPAN', BUILTIN_RULES).categoryId).toBe('eatout');
    expect(classify('東急ハンズ 渋谷', BUILTIN_RULES).categoryId).toBe('daily');
    expect(classify('スギ薬局 大井町', BUILTIN_RULES).categoryId).toBe('daily');
  });

  it('外食とカフェは内訳待ちにしない', () => {
    expect(classify('マクドナルド 品川', BUILTIN_RULES)).toMatchObject({ categoryId: 'eatout', ambiguous: false });
    expect(classify('STARBUCKS COFFEE', BUILTIN_RULES)).toMatchObject({ categoryId: 'cafe', ambiguous: false });
  });

  it('どのルールにも当たらなければ未分類', () => {
    expect(classify('ナゾノミセ', BUILTIN_RULES)).toMatchObject({ categoryId: UNCATEGORIZED_ID, ambiguous: false });
  });

  it('利用者のルールが初期搭載より優先される', () => {
    const learned = learnRule('ｾﾌﾞﾝ-ｲﾚﾌﾞﾝ', 'cafe');
    const result = classify('セブンイレブン', allRules([learned]));
    expect(result.categoryId).toBe('cafe');
    expect(result.ambiguous).toBe(false);
  });

  it('学習したルールは店名の表記揺れを跨いで当たる', () => {
    const learned = learnRule('ﾏﾂﾓﾄｷﾖｼ 五反田店 1234', 'daily');
    expect(pickRule('マツモトキヨシ五反田店', [learned])?.categoryId).toBe('daily');
  });

  it('壊れた正規表現を保存していても落ちない', () => {
    const broken = { id: 'x', pattern: '(', matchType: 'regex' as const, categoryId: 'food', priority: 200 };
    expect(() => classify('セブンイレブン', allRules([broken]))).not.toThrow();
    expect(classify('セブンイレブン', allRules([broken])).categoryId).toBe('food');
  });

  it('空の店名では何も当てない', () => {
    expect(pickRule('', BUILTIN_RULES)).toBeUndefined();
  });
});
