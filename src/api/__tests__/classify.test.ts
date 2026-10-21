import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SEED_CATEGORIES, UNCATEGORIZED_ID, learnItemRule, normalizeMerchant, type ClassifyTarget, type ReceiptItem, type Transaction, type Verdict } from '@kakeibo/core';

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

/*
 * ここで見るのは、判定を呼ぶこと・答えを core の採否に渡すこと・落ちたら空で進むことだけ。
 * 採否そのもの（確信度、手元にないカテゴリ、覚えた品目など）は core の classify-apply.test.ts
 */
describe('judgeReceiptItems', () => {
  it('品目を聞いて、答えを品目に当てる', async () => {
    api.classify.mockResolvedValue({ '0': { categoryId: 'rice', confidence: 0.95, status: 'accepted', parentId: 'food' } });
    const judged = await judgeReceiptItems(ITEMS, 'イトーヨーカドー', CATEGORIES);
    expect(api.classify.mock.calls[0][0]).toMatchObject({ kind: 'item', subjects: [{ key: '0' }, { key: '1' }] });
    expect(judged.items[0].categoryId).toBe('rice');
    expect(judged.warnings).toEqual([]);
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

  it('全部覚えていれば判定を呼ばない', async () => {
    const rules = [learnItemRule('ｺｼﾋｶﾘ 5kg', 'rice'), learnItemRule('ﾃｨｯｼｭ 5P', 'daily')];
    const judged = await judgeReceiptItems(ITEMS, '店', CATEGORIES, rules);
    expect(api.classify).not.toHaveBeenCalled();
    expect(judged.items.map((item) => item.categoryId)).toEqual(['rice', 'daily']);
  });
});

describe('judgeUnmatchedMerchants', () => {
  const LAWSON = txn('a', 'ローソン渋谷', 'food');
  const UNKNOWN = txn('b', '謎の商店', UNCATEGORIZED_ID);

  it('ルールに当たらなかった店を聞いて、答えを明細とルールに当てる', async () => {
    const key = normalizeMerchant('謎の商店');
    api.classify.mockResolvedValue({ [key]: { categoryId: 'hobby', confidence: 0.93, status: 'accepted' } });
    const judged = await judgeUnmatchedMerchants([LAWSON, UNKNOWN], CATEGORIES);
    expect(api.classify.mock.calls[0][0]).toMatchObject({ kind: 'merchant', subjects: [{ text: '謎の商店' }] });
    expect(judged.transactions[1].splits[0].categoryId).toBe('hobby');
    expect(judged.learned).toHaveLength(1);
  });

  it('聞く店が無ければ判定を呼ばない', async () => {
    const judged = await judgeUnmatchedMerchants([LAWSON], CATEGORIES);
    expect(api.classify).not.toHaveBeenCalled();
    expect(judged.transactions).toEqual([LAWSON]);
  });

  it('判定が落ちても明細はそのまま返す', async () => {
    api.classify.mockRejectedValue(new Error('落ちた'));
    const judged = await judgeUnmatchedMerchants([UNKNOWN], CATEGORIES);
    expect(judged.transactions).toEqual([UNKNOWN]);
    expect(judged.learned).toEqual([]);
  });
});
