import { describe, expect, it } from 'vitest';
import { UNCATEGORIZED_ID } from '../categories';
import { applyItemRules, classify, learnItemRule, learnItemRules, learnRule, pickItemRule } from '../rules';

describe('品目のルール', () => {
  it('全角半角・大文字小文字・空白の揺れは同じ品目として当てる', () => {
    const rule = learnItemRule('アイスGコーヒー', 'food-cafe');
    expect(pickItemRule('ｱｲｽ G ｺｰﾋｰ', [rule])?.categoryId).toBe('food-cafe');
    expect(pickItemRule('アイスｇコーヒー', [rule])?.categoryId).toBe('food-cafe');
  });

  /* 店舗名の正規化は数字を落とすので、品目には使わない */
  it('数字が違う品目は別の品目として扱う', () => {
    const rule = learnItemRule('コーラ 500ml', 'food-drink');
    expect(pickItemRule('コーラ 1.5L', [rule])).toBeUndefined();
  });

  it('店舗名のルールは品目に当てず、品目のルールは店舗名に当てない', () => {
    const itemRule = learnItemRule('ドトール', 'food-cafe');
    const merchantRule = learnRule('タリーズコーヒー', 'food-cafe');
    expect(classify('ドトール', [itemRule]).categoryId).toBe(UNCATEGORIZED_ID);
    expect(pickItemRule('タリーズコーヒー', [merchantRule])).toBeUndefined();
  });

  it('当たった品目にカテゴリを入れ、その位置を返す', () => {
    const { items, ruled } = applyItemRules(
      [
        { name: 'アイスGコーヒー', amount: 510, categoryId: UNCATEGORIZED_ID },
        { name: 'モーニングセット', amount: -100 },
      ],
      [learnItemRule('アイスGコーヒー', 'food-cafe')],
    );
    expect(items[0].categoryId).toBe('food-cafe');
    expect(items[1].categoryId).toBeUndefined();
    expect([...ruled]).toEqual([0]);
  });

  it('人が選び直した品目だけを覚え、未分類と空の名前は覚えない', () => {
    const rules = learnItemRules([
      { name: 'アイスGコーヒー', categoryId: 'food-cafe', categoryEdited: true },
      { name: 'マフィン', categoryId: 'food-deli' },
      { name: '謎の品', categoryId: UNCATEGORIZED_ID, categoryEdited: true },
      { name: ' ', categoryId: 'food', categoryEdited: true },
    ]);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ categoryId: 'food-cafe', target: 'item', matchType: 'equals' });
  });

  it('同じ品目を 2 回直したら後の方を覚える', () => {
    const rules = learnItemRules([
      { name: 'マフィン', categoryId: 'food-deli', categoryEdited: true },
      { name: 'ﾏﾌｨﾝ', categoryId: 'food-cafe', categoryEdited: true },
    ]);
    expect(rules).toHaveLength(1);
    expect(rules[0].categoryId).toBe('food-cafe');
  });
});
