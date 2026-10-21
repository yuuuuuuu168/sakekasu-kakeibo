import { describe, expect, it } from 'vitest';
import { SEED_CATEGORIES, UNCATEGORIZED_ID } from '../categories';
import { applyItemVerdicts, applyMerchantVerdicts, planItemJudgement, planMerchantJudgement } from '../classify';
import { normalizeMerchant } from '../merchant';
import { learnItemRule } from '../rules';
import type { ReceiptItem, Transaction } from '../types';

const CATEGORIES = [...SEED_CATEGORIES, { id: 'rice', label: '米・パン', order: 101, parentId: 'food' }];

const ITEMS: ReceiptItem[] = [
  { name: 'ｺｼﾋｶﾘ 5kg', amount: 2480, categoryId: 'food' },
  { name: 'ﾃｨｯｼｭ 5P', amount: 398, categoryId: 'daily' },
];

function txn(id: string, rawMerchant: string, categoryId: string, amount = 1200): Transaction {
  return {
    id,
    date: '2026-09-01',
    amount,
    rawMerchant,
    merchant: normalizeMerchant(rawMerchant),
    source: 'credit',
    sourceLabel: '楽天カード',
    splits: [{ id: `${id}-1`, amount, categoryId, origin: categoryId === UNCATEGORIZED_ID ? 'fallback' : 'rule' }],
    needsDetail: false,
  };
}

describe('planItemJudgement', () => {
  it('品目名を聞き、レシートの店舗名を手がかりとして渡す', () => {
    const plan = planItemJudgement(ITEMS, 'イトーヨーカドー', CATEGORIES);
    expect(plan.target.kind).toBe('item');
    expect(plan.target.subjects).toEqual([
      { key: '0', text: 'ｺｼﾋｶﾘ 5kg', context: 'イトーヨーカドー' },
      { key: '1', text: 'ﾃｨｯｼｭ 5P', context: 'イトーヨーカドー' },
    ]);
  });

  it('負の金額の行は聞かない', () => {
    const plan = planItemJudgement([...ITEMS, { name: 'ｺｼﾋｶﾘ 値引', amount: -200, categoryId: 'discount' }], '店', CATEGORIES);
    expect(plan.target.subjects.map((subject) => subject.key)).toEqual(['0', '1']);
  });

  it('覚えた品目は聞かず、そのカテゴリにする。答えの鍵は元の位置のまま', () => {
    const plan = planItemJudgement(ITEMS, '店', CATEGORIES, [learnItemRule('ｺｼﾋｶﾘ 5kg', 'rice')]);
    expect(plan.target.subjects.map((subject) => subject.key)).toEqual(['1']);
    expect(plan.items[0].categoryId).toBe('rice');
  });

  it('覚えたカテゴリが今は無ければ、覚えていないのと同じに扱う', () => {
    const plan = planItemJudgement(ITEMS, '店', CATEGORIES, [learnItemRule('ｺｼﾋｶﾘ 5kg', 'gone')]);
    expect(plan.target.subjects).toHaveLength(2);
    expect(plan.items[0].categoryId).toBe('food');
  });
});

describe('applyItemVerdicts', () => {
  const plan = planItemJudgement(ITEMS, '店', CATEGORIES);

  it('確信が高い答えでカテゴリを入れ替える', () => {
    const judged = applyItemVerdicts(plan, { '0': { categoryId: 'rice', confidence: 0.95, status: 'accepted', parentId: 'food' } }, CATEGORIES);
    expect(judged.items[0].categoryId).toBe('rice');
    expect(judged.warnings).toEqual([]);
  });

  it('確信が中くらいならカテゴリは入れるが注意を残す', () => {
    const judged = applyItemVerdicts(plan, { '1': { categoryId: 'apparel', confidence: 0.6, status: 'review' } }, CATEGORIES);
    expect(judged.items[1].categoryId).toBe('apparel');
    expect(judged.warnings[0]).toContain('ﾃｨｯｼｭ 5P');
    expect(judged.warnings[0]).toContain('衣類・散髪');
  });

  it('判断できなかった品目はキーワード表の答えを残す', () => {
    const judged = applyItemVerdicts(plan, { '1': { categoryId: UNCATEGORIZED_ID, confidence: 0.2, status: 'unresolved' } }, CATEGORIES);
    expect(judged.items[1].categoryId).toBe('daily');
  });

  /*
   * 判定の側でも同じ検査をしているが、内訳に書き込むのはこちらなので、
   * 手元にないカテゴリを渡されたら書かない。どの行にも出てこない額を作らせないため
   */
  it('手元にないカテゴリを返されたら使わない', () => {
    const judged = applyItemVerdicts(plan, { '0': { categoryId: 'ghost', confidence: 0.99, status: 'accepted' } }, CATEGORIES);
    expect(judged.items[0].categoryId).toBe('food');
    expect(judged.warnings).toEqual([]);
  });

  it('使わなくなったカテゴリを返されたら使わない', () => {
    const archived = CATEGORIES.map((category) => (category.id === 'apparel' ? { ...category, archived: true } : category));
    const judged = applyItemVerdicts(plan, { '0': { categoryId: 'apparel', confidence: 0.99, status: 'accepted' } }, archived);
    expect(judged.items[0].categoryId).toBe('food');
  });

  it('聞かなかった行に答えが混ざっていても書き換えない', () => {
    const ruled = planItemJudgement(ITEMS, '店', CATEGORIES, [learnItemRule('ｺｼﾋｶﾘ 5kg', 'rice')]);
    const judged = applyItemVerdicts(ruled, { '0': { categoryId: 'daily', confidence: 0.99, status: 'accepted' } }, CATEGORIES);
    expect(judged.items[0].categoryId).toBe('rice');
  });
});

describe('planMerchantJudgement と applyMerchantVerdicts', () => {
  const LAWSON = txn('a', 'ローソン渋谷', 'food');
  const UNKNOWN = txn('b', '謎の商店', UNCATEGORIZED_ID);
  const UNKNOWN_AGAIN = txn('c', '謎の商店', UNCATEGORIZED_ID, 800);
  const KEY = normalizeMerchant('謎の商店');

  it('ルールに当たらなかった店だけを、1 回ずつ聞く', () => {
    const plan = planMerchantJudgement([LAWSON, UNKNOWN, UNKNOWN_AGAIN], CATEGORIES);
    expect(plan.target.kind).toBe('merchant');
    expect(plan.target.subjects).toEqual([{ key: KEY, text: '謎の商店' }]);
  });

  it('内訳を割った明細は聞かない', () => {
    const split: Transaction = {
      ...UNKNOWN,
      splits: [
        { id: 'b-1', amount: 400, categoryId: UNCATEGORIZED_ID, origin: 'manual' },
        { id: 'b-2', amount: 800, categoryId: 'food', origin: 'manual' },
      ],
    };
    expect(planMerchantJudgement([split], CATEGORIES).target.subjects).toEqual([]);
  });

  it('答えは同じ店の全部の行に効き、確信が高ければルールとして覚える', () => {
    const transactions = [UNKNOWN, UNKNOWN_AGAIN];
    const plan = planMerchantJudgement(transactions, CATEGORIES);
    const judged = applyMerchantVerdicts(transactions, plan, { [KEY]: { categoryId: 'hobby', confidence: 0.93, status: 'accepted' } }, CATEGORIES);
    expect(judged.transactions.map((item) => item.splits[0].categoryId)).toEqual(['hobby', 'hobby']);
    expect(judged.judged).toBe(1);
    expect(judged.learned).toHaveLength(1);
    expect(judged.learned[0]).toMatchObject({ categoryId: 'hobby', matchType: 'equals' });
  });

  it('確信が中くらいならカテゴリだけ入れて、ルールは作らない', () => {
    const plan = planMerchantJudgement([UNKNOWN], CATEGORIES);
    const judged = applyMerchantVerdicts([UNKNOWN], plan, { [KEY]: { categoryId: 'hobby', confidence: 0.55, status: 'review' } }, CATEGORIES);
    expect(judged.transactions[0].splits[0].categoryId).toBe('hobby');
    expect(judged.learned).toEqual([]);
  });

  it('判断できなかった店は未分類のまま', () => {
    const plan = planMerchantJudgement([UNKNOWN], CATEGORIES);
    const judged = applyMerchantVerdicts(
      [UNKNOWN],
      plan,
      { [KEY]: { categoryId: UNCATEGORIZED_ID, confidence: 0.1, status: 'unresolved' } },
      CATEGORIES,
    );
    expect(judged.transactions[0].splits[0].categoryId).toBe(UNCATEGORIZED_ID);
    expect(judged.judged).toBe(0);
  });

  it('手元にないカテゴリを返されたら、内訳もルールも書き換えない', () => {
    const plan = planMerchantJudgement([UNKNOWN], CATEGORIES);
    const judged = applyMerchantVerdicts([UNKNOWN], plan, { [KEY]: { categoryId: 'ghost', confidence: 0.99, status: 'accepted' } }, CATEGORIES);
    expect(judged.transactions[0].splits[0].categoryId).toBe(UNCATEGORIZED_ID);
    expect(judged.learned).toEqual([]);
    expect(judged.judged).toBe(0);
  });

  it('ルールに当たった明細は書き換えない', () => {
    const plan = planMerchantJudgement([LAWSON], CATEGORIES);
    const judged = applyMerchantVerdicts([LAWSON], plan, {}, CATEGORIES);
    expect(judged.transactions).toEqual([LAWSON]);
  });
});
