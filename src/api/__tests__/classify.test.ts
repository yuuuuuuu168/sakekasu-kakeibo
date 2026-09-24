import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SEED_CATEGORIES, UNCATEGORIZED_ID, normalizeMerchant, type ClassifyTarget, type ReceiptItem, type Transaction, type Verdict } from '@kakeibo/core';

const api = vi.hoisted(() => ({ classify: vi.fn<(target: ClassifyTarget) => Promise<Record<string, Verdict>>>() }));
vi.mock('../index', () => ({ api }));

const { judgeReceiptItems, judgeUnmatchedMerchants } = await import('../classify');

const CATEGORIES = [
  ...SEED_CATEGORIES,
  { id: 'rice', label: '米・パン', order: 101, parentId: 'food' },
];

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

beforeEach(() => {
  api.classify.mockReset();
});

describe('judgeReceiptItems', () => {
  it('確信が高い判定でカテゴリを入れ替える', async () => {
    api.classify.mockResolvedValue({ '0': { categoryId: 'rice', confidence: 0.95, status: 'accepted', parentId: 'food' } });
    const judged = await judgeReceiptItems(ITEMS, 'イトーヨーカドー', CATEGORIES);
    expect(judged.items[0].categoryId).toBe('rice');
    expect(judged.warnings).toEqual([]);
  });

  it('確信が中くらいならカテゴリは入れるが注意を残す', async () => {
    api.classify.mockResolvedValue({ '1': { categoryId: 'apparel', confidence: 0.6, status: 'review' } });
    const judged = await judgeReceiptItems(ITEMS, '店', CATEGORIES);
    expect(judged.items[1].categoryId).toBe('apparel');
    expect(judged.warnings[0]).toContain('ﾃｨｯｼｭ 5P');
    expect(judged.warnings[0]).toContain('衣類・美容');
  });

  it('判断できなかった品目はキーワード表の答えを残す', async () => {
    api.classify.mockResolvedValue({ '1': { categoryId: UNCATEGORIZED_ID, confidence: 0.2, status: 'unresolved' } });
    const judged = await judgeReceiptItems(ITEMS, '店', CATEGORIES);
    expect(judged.items[1].categoryId).toBe('daily');
  });

  it('レシートの店舗名を手がかりとして渡す', async () => {
    api.classify.mockResolvedValue({});
    await judgeReceiptItems(ITEMS, 'イトーヨーカドー', CATEGORIES);
    const target = api.classify.mock.calls[0][0];
    expect(target.kind).toBe('item');
    expect(target.subjects).toEqual([
      { key: '0', text: 'ｺｼﾋｶﾘ 5kg', context: 'イトーヨーカドー' },
      { key: '1', text: 'ﾃｨｯｼｭ 5P', context: 'イトーヨーカドー' },
    ]);
  });

  /*
   * 判定の側でも同じ検査をしているが、内訳に書き込むのはこちらなので、
   * 手元にないカテゴリを渡されたら書かない。どの行にも出てこない額を作らせないため
   */
  it('手元にないカテゴリを返されたら使わない', async () => {
    api.classify.mockResolvedValue({ '0': { categoryId: 'ghost', confidence: 0.99, status: 'accepted' } });
    const judged = await judgeReceiptItems(ITEMS, '店', CATEGORIES);
    expect(judged.items[0].categoryId).toBe('food');
    expect(judged.warnings).toEqual([]);
  });

  it('使わなくなったカテゴリを返されたら使わない', async () => {
    const archived = CATEGORIES.map((category) => (category.id === 'apparel' ? { ...category, archived: true } : category));
    api.classify.mockResolvedValue({ '0': { categoryId: 'apparel', confidence: 0.99, status: 'accepted' } });
    const judged = await judgeReceiptItems(ITEMS, '店', archived);
    expect(judged.items[0].categoryId).toBe('food');
  });

  it('判定が落ちても品目はそのまま返す', async () => {
    api.classify.mockRejectedValue(new Error('AWS 側が必要です'));
    const judged = await judgeReceiptItems(ITEMS, '店', CATEGORIES);
    expect(judged.items).toEqual(ITEMS);
    expect(judged.warnings).toEqual([]);
  });

  it('品目が無ければ判定を呼ばない', async () => {
    const judged = await judgeReceiptItems([], '店', CATEGORIES);
    expect(api.classify).not.toHaveBeenCalled();
    expect(judged.items).toEqual([]);
  });
});

describe('judgeUnmatchedMerchants', () => {
  const LAWSON = txn('a', 'ローソン渋谷', 'food');
  const UNKNOWN = txn('b', '謎の商店', UNCATEGORIZED_ID);
  const UNKNOWN_AGAIN = txn('c', '謎の商店', UNCATEGORIZED_ID, 800);

  it('ルールに当たらなかった店だけを聞く', async () => {
    api.classify.mockResolvedValue({});
    await judgeUnmatchedMerchants([LAWSON, UNKNOWN], CATEGORIES);
    const target = api.classify.mock.calls[0][0];
    expect(target.kind).toBe('merchant');
    expect(target.subjects.map((subject) => subject.text)).toEqual(['謎の商店']);
  });

  it('同じ店は 1 回しか聞かず、結果は全部の行に効く', async () => {
    const key = normalizeMerchant('謎の商店');
    api.classify.mockResolvedValue({ [key]: { categoryId: 'hobby', confidence: 0.93, status: 'accepted' } });

    const judged = await judgeUnmatchedMerchants([UNKNOWN, UNKNOWN_AGAIN], CATEGORIES);
    expect(api.classify.mock.calls[0][0].subjects).toHaveLength(1);
    expect(judged.transactions.map((item) => item.splits[0].categoryId)).toEqual(['hobby', 'hobby']);
    expect(judged.judged).toBe(1);
  });

  it('確信が高い店はルールとして覚える', async () => {
    const key = normalizeMerchant('謎の商店');
    api.classify.mockResolvedValue({ [key]: { categoryId: 'hobby', confidence: 0.93, status: 'accepted' } });
    const judged = await judgeUnmatchedMerchants([UNKNOWN], CATEGORIES);
    expect(judged.learned).toHaveLength(1);
    expect(judged.learned[0]).toMatchObject({ categoryId: 'hobby', matchType: 'equals' });
  });

  it('確信が中くらいならカテゴリだけ入れて、ルールは作らない', async () => {
    const key = normalizeMerchant('謎の商店');
    api.classify.mockResolvedValue({ [key]: { categoryId: 'hobby', confidence: 0.55, status: 'review' } });
    const judged = await judgeUnmatchedMerchants([UNKNOWN], CATEGORIES);
    expect(judged.transactions[0].splits[0].categoryId).toBe('hobby');
    expect(judged.learned).toEqual([]);
  });

  it('判断できなかった店は未分類のまま', async () => {
    const key = normalizeMerchant('謎の商店');
    api.classify.mockResolvedValue({ [key]: { categoryId: UNCATEGORIZED_ID, confidence: 0.1, status: 'unresolved' } });
    const judged = await judgeUnmatchedMerchants([UNKNOWN], CATEGORIES);
    expect(judged.transactions[0].splits[0].categoryId).toBe(UNCATEGORIZED_ID);
    expect(judged.judged).toBe(0);
  });

  it('手元にないカテゴリを返されたら、内訳もルールも書き換えない', async () => {
    const key = normalizeMerchant('謎の商店');
    api.classify.mockResolvedValue({ [key]: { categoryId: 'ghost', confidence: 0.99, status: 'accepted' } });
    const judged = await judgeUnmatchedMerchants([UNKNOWN], CATEGORIES);
    expect(judged.transactions[0].splits[0].categoryId).toBe(UNCATEGORIZED_ID);
    expect(judged.learned).toEqual([]);
    expect(judged.judged).toBe(0);
  });

  it('内訳を割った明細には触らない', async () => {
    const split: Transaction = {
      ...UNKNOWN,
      splits: [
        { id: 'b-1', amount: 400, categoryId: UNCATEGORIZED_ID, origin: 'manual' },
        { id: 'b-2', amount: 800, categoryId: 'food', origin: 'manual' },
      ],
    };
    api.classify.mockResolvedValue({});
    const judged = await judgeUnmatchedMerchants([split], CATEGORIES);
    expect(api.classify).not.toHaveBeenCalled();
    expect(judged.transactions[0]).toEqual(split);
  });

  it('判定が落ちても明細はそのまま返す', async () => {
    api.classify.mockRejectedValue(new Error('落ちた'));
    const judged = await judgeUnmatchedMerchants([UNKNOWN], CATEGORIES);
    expect(judged.transactions).toEqual([UNKNOWN]);
    expect(judged.learned).toEqual([]);
  });
});
