import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  ACCEPT_CONFIDENCE,
  NONE_OF_CHILDREN,
  REVIEW_CONFIDENCE,
  childChoiceSpecs,
  decideVerdict,
  decideVerdicts,
  parentChoiceSpecs,
  summarizeVerdicts,
  type ChoiceAnswer,
  type ClassifyTarget,
} from '../classify';
import { DISCOUNT_ID, SEED_CATEGORIES, TRANSFER_ID, UNCATEGORIZED_ID } from '../categories';
import type { Category } from '../types';

/** 初期カテゴリから切り離した形。小カテゴリは食費の下にだけ置いて、2 段目の扱いを見る */
const NESTED: Category[] = [
  { id: 'food', label: '食費', order: 1 },
  { id: 'cafe', label: 'カフェ', order: 2 },
  { id: 'daily', label: '日用品', order: 3 },
  { id: TRANSFER_ID, label: '振替・チャージ', order: 90 },
  { id: UNCATEGORIZED_ID, label: '未分類', order: 99 },
  { id: 'rice', label: '米・パン', order: 101, parentId: 'food' },
  { id: 'deli', label: '惣菜', order: 102, parentId: 'food' },
];

const RECEIPT: ClassifyTarget = {
  kind: 'item',
  subjects: [
    { key: 's0', text: 'ｺｼﾋｶﾘ 5kg', context: 'イトーヨーカドー' },
    { key: 's1', text: 'ﾃｨｯｼｭ 5P', context: 'イトーヨーカドー' },
  ],
  categories: NESTED,
};

const answer = (choice: string, confidence: number): ChoiceAnswer => ({ choice, confidence });

describe('parentChoiceSpecs', () => {
  it('品目ごとに 1 問、選択肢は大カテゴリだけ', () => {
    const specs = parentChoiceSpecs(RECEIPT);
    expect(specs.map((spec) => spec.name)).toEqual(['s0', 's1']);
    expect(Object.keys(specs[0].criteria)).toContain('food');
    expect(Object.keys(specs[0].criteria)).not.toContain('rice');
  });

  it('値引きは選択肢に入れない', () => {
    const specs = parentChoiceSpecs({ ...RECEIPT, categories: SEED_CATEGORIES });
    expect(Object.keys(specs[0].criteria)).toContain('food');
    expect(Object.keys(specs[0].criteria)).not.toContain(DISCOUNT_ID);
  });

  it('レシートの店舗名を質問に混ぜる', () => {
    expect(parentChoiceSpecs(RECEIPT)[0].instructions).toContain('イトーヨーカドー');
    expect(parentChoiceSpecs(RECEIPT)[0].instructions).toContain('ｺｼﾋｶﾘ 5kg');
  });

  it('店舗名の判定では文脈を付けない', () => {
    const specs = parentChoiceSpecs({ kind: 'merchant', subjects: [{ key: 'm0', text: 'ローソン渋谷' }], categories: NESTED });
    expect(specs[0].instructions).toContain('ローソン渋谷');
  });

  it('未分類と振替には言葉を足して意味を伝える', () => {
    const criteria = parentChoiceSpecs(RECEIPT)[0].criteria;
    expect(criteria[UNCATEGORIZED_ID]).toContain('当てはまらない');
    expect(criteria[TRANSFER_ID]).toContain('残高');
  });

  it('使わなくなったカテゴリは選択肢に出さない', () => {
    const archived: Category[] = NESTED.map((category) => (category.id === 'cafe' ? { ...category, archived: true } : category));
    const criteria = parentChoiceSpecs({ ...RECEIPT, categories: archived })[0].criteria;
    expect(criteria.cafe).toBeUndefined();
  });

  it('選択肢が 1 つも無ければ何も聞かない', () => {
    expect(parentChoiceSpecs({ ...RECEIPT, categories: [] })).toEqual([]);
  });
});

describe('childChoiceSpecs', () => {
  it('小カテゴリを持つ大カテゴリにだけ 2 段目を聞く', () => {
    const specs = childChoiceSpecs(RECEIPT, { s0: answer('food', 0.95), s1: answer('daily', 0.95) });
    expect(specs.map((spec) => spec.name)).toEqual(['s0']);
    expect(Object.keys(specs[0].criteria)).toEqual(['rice', 'deli', NONE_OF_CHILDREN]);
  });

  it('大カテゴリの確信が低ければ 2 段目は聞かない', () => {
    expect(childChoiceSpecs(RECEIPT, { s0: answer('food', 0.2) })).toEqual([]);
  });

  it('1 段目の答えが無ければ聞かない', () => {
    expect(childChoiceSpecs(RECEIPT, {})).toEqual([]);
  });
});

describe('decideVerdict', () => {
  it('確信が高ければそのまま使う', () => {
    expect(decideVerdict(NESTED, answer('daily', 0.97), undefined)).toEqual({
      categoryId: 'daily',
      confidence: 0.97,
      status: 'accepted',
    });
  });

  it('中くらいなら使うが人に見せる', () => {
    expect(decideVerdict(NESTED, answer('daily', 0.6), undefined).status).toBe('review');
  });

  it('低ければ未分類に落とす', () => {
    expect(decideVerdict(NESTED, answer('daily', 0.3), undefined)).toEqual({
      categoryId: UNCATEGORIZED_ID,
      confidence: 0.3,
      status: 'unresolved',
    });
  });

  it('小カテゴリまで決まれば小カテゴリを返す', () => {
    const verdict = decideVerdict(NESTED, answer('food', 1), answer('rice', 0.9));
    expect(verdict.categoryId).toBe('rice');
    expect(verdict.parentId).toBe('food');
    expect(verdict.confidence).toBeCloseTo(0.9);
  });

  it('小カテゴリのどれでもないときは大カテゴリで止める', () => {
    const verdict = decideVerdict(NESTED, answer('food', 0.95), answer(NONE_OF_CHILDREN, 0.99));
    expect(verdict.categoryId).toBe('food');
    expect(verdict.parentId).toBeUndefined();
  });

  it('小カテゴリの確信が低いときも大カテゴリで止める', () => {
    expect(decideVerdict(NESTED, answer('food', 0.95), answer('rice', 0.3)).categoryId).toBe('food');
  });

  /*
   * 明細の文字列はそのまま問いに入るので、2 段目の答えが選んだ大カテゴリの外を指すことがある。
   * 通すと親子の食い違った結論が「採用」として学習されるので、大カテゴリで止める
   */
  it.each([
    ['別の大カテゴリそのもの', 'daily'],
    ['未分類', UNCATEGORIZED_ID],
    ['別の大カテゴリの子', 'soap'],
  ])('2 段目が選んだ大カテゴリの外（%s）を指したら大カテゴリで止める', (_label, choice) => {
    const categories: Category[] = [...NESTED, { id: 'soap', label: '洗剤', order: 103, parentId: 'daily' }];
    const verdict = decideVerdict(categories, answer('food', 0.97), answer(choice, 0.99));
    expect(verdict).toEqual({ categoryId: 'food', confidence: 0.97, status: 'accepted' });
  });

  it('2 つの積が線を下回れば大カテゴリで止める', () => {
    // 0.6 × 0.6 = 0.36。小カテゴリまで下りると確信が足りない
    const verdict = decideVerdict(NESTED, answer('food', 0.6), answer('rice', 0.6));
    expect(verdict.categoryId).toBe('food');
    expect(verdict.confidence).toBeCloseTo(0.6);
  });

  it('未分類を選んだ答えは確信が高くても未解決にする', () => {
    expect(decideVerdict(NESTED, answer(UNCATEGORIZED_ID, 0.99), undefined).status).toBe('unresolved');
  });

  it('知らないカテゴリを返されたら未分類にする', () => {
    expect(decideVerdict(NESTED, answer('nope', 0.99), undefined).status).toBe('unresolved');
  });

  it('答えが無ければ未分類にする', () => {
    expect(decideVerdict(NESTED, undefined, undefined)).toEqual({
      categoryId: UNCATEGORIZED_ID,
      confidence: 0,
      status: 'unresolved',
    });
  });

  it('使わなくなったカテゴリを返されたら未分類にする', () => {
    const archived: Category[] = NESTED.map((category) => (category.id === 'cafe' ? { ...category, archived: true } : category));
    expect(decideVerdict(archived, answer('cafe', 0.99), undefined).status).toBe('unresolved');
  });

  it('決まったカテゴリは必ず渡したカテゴリのどれか', () => {
    const ids = NESTED.filter((category) => !category.archived).map((category) => category.id);
    fc.assert(
      fc.property(
        fc.constantFrom(...ids, 'nope'),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.constantFrom(...ids, NONE_OF_CHILDREN, 'nope'),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (parentChoice, parentConfidence, childChoice, childConfidence) => {
          const verdict = decideVerdict(
            NESTED,
            answer(parentChoice, parentConfidence),
            answer(childChoice, childConfidence),
          );
          expect(ids).toContain(verdict.categoryId);
          expect(verdict.confidence).toBeGreaterThanOrEqual(0);
          expect(verdict.confidence).toBeLessThanOrEqual(1);
          if (verdict.status === 'accepted') expect(verdict.confidence).toBeGreaterThanOrEqual(ACCEPT_CONFIDENCE);
          if (verdict.status === 'review') expect(verdict.confidence).toBeGreaterThanOrEqual(REVIEW_CONFIDENCE);
          if (verdict.categoryId === UNCATEGORIZED_ID) expect(verdict.status).toBe('unresolved');
        },
      ),
    );
  });
});

describe('decideVerdicts', () => {
  it('品目の数だけ結論を返す', () => {
    const verdicts = decideVerdicts(RECEIPT, { s0: answer('food', 1), s1: answer('daily', 0.9) }, { s0: answer('rice', 0.95) });
    expect(verdicts.s0.categoryId).toBe('rice');
    expect(verdicts.s1.categoryId).toBe('daily');
  });

  it('答えが 1 つも無ければ全部未分類', () => {
    const verdicts = decideVerdicts(RECEIPT, {}, {});
    expect(Object.values(verdicts).every((verdict) => verdict.categoryId === UNCATEGORIZED_ID)).toBe(true);
  });
});

describe('初期カテゴリで聞く', () => {
  const target: ClassifyTarget = {
    kind: 'item',
    subjects: [{ key: 's0', text: 'AWS Lambda 本格入門', context: 'AMAZON' }],
    categories: SEED_CATEGORIES,
  };

  it('1 段目は大カテゴリだけを並べる', () => {
    const [spec] = parentChoiceSpecs(target);
    expect(Object.keys(spec.criteria)).toContain('work');
    expect(Object.keys(spec.criteria)).not.toContain('work-books');
    expect(Object.keys(spec.criteria)).toHaveLength(15);
  });

  it('2 段目は選んだ大カテゴリの小カテゴリと「どれでもない」', () => {
    const [spec] = childChoiceSpecs(target, { s0: { choice: 'work', confidence: 0.9 } });
    expect(Object.keys(spec.criteria)).toEqual([
      'work-ai',
      'work-cloud',
      'work-devtools',
      'work-courses',
      'work-books',
      NONE_OF_CHILDREN,
    ]);
  });
});

describe('summarizeVerdicts', () => {
  it('結論ごとの件数を数え、中身は持たない', () => {
    const summary = summarizeVerdicts({
      a: { categoryId: 'food-cafe', confidence: 0.9, status: 'accepted', parentId: 'food' },
      b: { categoryId: 'food', confidence: 0.6, status: 'review' },
      c: { categoryId: 'uncategorized', confidence: 0.2, status: 'unresolved' },
    });
    expect(summary).toEqual({ 件数: 3, そのまま入れた: 1, 人に見せた: 1, 捨てた: 1, 小カテゴリまで: 1 });
  });
});
