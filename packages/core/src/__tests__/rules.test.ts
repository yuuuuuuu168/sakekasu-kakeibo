import { describe, expect, it } from 'vitest';
import { BUILTIN_RULES, allRules, classify, learnRule, pickRule, shouldLearnRule } from '../rules';
import { SEED_CATEGORIES, TRANSFER_ID, UNCATEGORIZED_ID } from '../categories';

describe('classify', () => {
  it('コンビニは食費だが内訳待ちにする', () => {
    const result = classify('ｾﾌﾞﾝ-ｲﾚﾌﾞﾝ 品川店', BUILTIN_RULES);
    expect(result.categoryId).toBe('food');
    expect(result.ambiguous).toBe(true);
  });

  it('長いパターンが短いパターンに勝つ', () => {
    expect(classify('AMAZON.CO.JP*M12AB3', BUILTIN_RULES).categoryId).toBe('daily');
    expect(classify('AMAZON PRIME*JP', BUILTIN_RULES).categoryId).toBe('fees-membership');
    expect(classify('UBER EATS JAPAN', BUILTIN_RULES).categoryId).toBe('food-eatout');
    expect(classify('東急ハンズ 渋谷', BUILTIN_RULES).categoryId).toBe('daily-household');
    expect(classify('スギ薬局 大井町', BUILTIN_RULES).categoryId).toBe('daily');
  });

  it('外食とカフェは内訳待ちにしない', () => {
    expect(classify('マクドナルド 品川', BUILTIN_RULES)).toMatchObject({ categoryId: 'food-eatout', ambiguous: false });
    expect(classify('STARBUCKS COFFEE', BUILTIN_RULES)).toMatchObject({ categoryId: 'food-cafe', ambiguous: false });
  });

  it('居酒屋は酒ではなく外食', () => {
    expect(classify('居酒屋 はなこ', BUILTIN_RULES).categoryId).toBe('food-eatout');
  });

  it('Google 名義の請求は推し活、DMM は趣味・娯楽', () => {
    expect(classify('GOOGLE *YouTube', BUILTIN_RULES).categoryId).toBe('oshi-youtube');
    expect(classify('DMM.COM', BUILTIN_RULES).categoryId).toBe('hobby-dmm');
  });

  it('AWS は LAWSON に紛れ込まない', () => {
    expect(classify('AMAZON WEB SERVICES', BUILTIN_RULES).categoryId).toBe('work-cloud');
    expect(classify('LAWSON 品川', BUILTIN_RULES).categoryId).not.toBe('work-cloud');
  });

  it('ポイント充当とキャッシュバックは振替', () => {
    expect(classify('楽天ポイント充当', BUILTIN_RULES).categoryId).toBe(TRANSFER_ID);
    expect(classify('PayPayキャッシュバック', BUILTIN_RULES).categoryId).toBe(TRANSFER_ID);
  });

  it('初期ルールは初期カテゴリにある ID だけを指す', () => {
    const known = new Set(SEED_CATEGORIES.map((category) => category.id));
    for (const rule of BUILTIN_RULES) expect(known.has(rule.categoryId), rule.pattern).toBe(true);
  });
});

describe('金額で行き先が変わるルール', () => {
  it('JR の 3,000 円以上は新幹線、それ未満は電車', () => {
    expect(classify('JR東日本 えきねっと以外', BUILTIN_RULES, 14_170).categoryId).toBe('transport-shinkansen');
    expect(classify('JR東日本', BUILTIN_RULES, 3_000).categoryId).toBe('transport-shinkansen');
    expect(classify('JR東日本', BUILTIN_RULES, 2_999).categoryId).toBe('transport-train');
  });

  it('金額が分からなければ下限額のあるルールは当てない', () => {
    expect(classify('JR東海', BUILTIN_RULES).categoryId).toBe('transport-train');
  });
});

describe('shouldLearnRule', () => {
  it('混ざる店は覚えない', () => {
    expect(shouldLearnRule('AMAZON.CO.JP*M12AB3', BUILTIN_RULES)).toBe(false);
    expect(shouldLearnRule('ｾﾌﾞﾝ-ｲﾚﾌﾞﾝ 品川店', BUILTIN_RULES)).toBe(false);
  });

  it('普通の店と、ルールの無い店は覚える', () => {
    expect(shouldLearnRule('マクドナルド 品川', BUILTIN_RULES)).toBe(true);
    expect(shouldLearnRule('ナゾノミセ', BUILTIN_RULES)).toBe(true);
  });

  it('店名が空なら覚えない', () => {
    expect(shouldLearnRule('', BUILTIN_RULES)).toBe(false);
  });

  it('どのルールにも当たらなければ未分類', () => {
    expect(classify('ナゾノミセ', BUILTIN_RULES)).toMatchObject({ categoryId: UNCATEGORIZED_ID, ambiguous: false });
  });

  it('利用者のルールが初期搭載より優先される', () => {
    const learned = learnRule('ｾﾌﾞﾝ-ｲﾚﾌﾞﾝ', 'food-cafe');
    const result = classify('セブンイレブン', allRules([learned]));
    expect(result.categoryId).toBe('food-cafe');
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
