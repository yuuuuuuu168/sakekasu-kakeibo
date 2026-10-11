import { describe, expect, it } from 'vitest';
import { UNCATEGORIZED_ID } from '../categories';
import { applyItemRules, classify, learnItemRule, learnItemRules, learnRule, mergeItemRules, pickItemRule } from '../rules';

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

describe('品目のルールの覚え方（値引きと長い品目名）', () => {
  it('金額がマイナスの行（値引き・ポイント利用）は覚えない', () => {
    const rules = learnItemRules([
      { name: 'アプリポイント利用', amount: -300, categoryId: 'food-eatout', categoryEdited: true },
      { name: 'モーニングセット', amount: -100, categoryId: 'food-cafe', categoryEdited: true },
      { name: 'チーズハンバーグ300G', amount: 1280, categoryId: 'food-eatout', categoryEdited: true },
    ]);
    expect(rules.map((rule) => rule.pattern)).toEqual(['チーズハンバーグ300G']);
  });

  it('品目名を切り詰めずに ID を作るので、先頭 40 文字が同じ別の品目も別のルールになる', () => {
    const head = 'JSAUX携帯スマホスタンド、折り畳み薄型アルミ合金製角度調整可能スマホスタンド卓上';
    const rules = learnItemRules([
      { name: `${head}(グレー)`, amount: 1999, categoryId: 'hobby-gadgets', categoryEdited: true },
      { name: `${head}(ブラック)`, amount: 1999, categoryId: 'daily', categoryEdited: true },
    ]);
    expect(rules).toHaveLength(2);
    expect(new Set(rules.map((rule) => rule.id)).size).toBe(2);
  });

  it('同じ品目名の古いルールは、ID の作り方が違っていても置き換える', () => {
    const name = 'HOSHIMACHISUISEIARENATOUR2026ONCEUPONASTELLARLIVEVIEWING全席指定';
    const old = { ...learnItemRule(name, 'oshi'), id: `learned-item-${name.slice(0, 40)}` };
    const merchant = learnRule('タリーズコーヒー', 'food-cafe');
    const merged = mergeItemRules([old, merchant], [learnItemRule(name, 'oshi-hololive')]);
    expect(merged.filter((rule) => rule.target === 'item')).toHaveLength(1);
    expect(pickItemRule(name, merged)?.categoryId).toBe('oshi-hololive');
    // 店舗名のルールには触らない
    expect(merged).toContainEqual(merchant);
  });
});
