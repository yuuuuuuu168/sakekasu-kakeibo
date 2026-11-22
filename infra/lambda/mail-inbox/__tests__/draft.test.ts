import { describe, expect, it } from 'vitest';
import type { Receipt } from '@kakeibo/core';
import { MAIL_MAX_AMOUNT, MAIL_MAX_ITEMS, findExisting, parseMailDraft, receiptFromDraft, type MailDraft } from '../draft';

const base = {
  date: '2026-11-22',
  store: 'Amazon',
  title: 'モノンズのアイマスク',
  amount: 1398,
  order_number: '250-4917807-1616660',
  source: 'mail',
  message_id: '<abc@mail.example>',
};

function fields(body: unknown): string[] {
  const parsed = parseMailDraft(body);
  return parsed.ok ? [] : parsed.details.map((detail) => detail.field);
}

describe('parseMailDraft', () => {
  it('仕様書の例を受け付け、items が無ければ title と amount を 1 品目にする', () => {
    expect(parseMailDraft({ ...base, category: '日用品' })).toEqual({
      ok: true,
      draft: {
        date: '2026-11-22',
        store: 'Amazon',
        title: 'モノンズのアイマスク',
        amount: 1398,
        orderNumber: '250-4917807-1616660',
        messageId: '<abc@mail.example>',
        items: [{ name: 'モノンズのアイマスク', amount: 1398 }],
      },
    });
  });

  it('品目・送料・割引を並べて、合計が amount と合えば受け付ける', () => {
    const parsed = parseMailDraft({
      ...base,
      amount: 2500,
      items: [
        { name: 'モノンズのアイマスク', amount: 1398 },
        { name: '日用品B', amount: 1302 },
        { name: '送料', amount: 300 },
        { name: '割引', amount: -500 },
      ],
    });
    expect(parsed.ok && parsed.draft.items).toHaveLength(4);
  });

  it('品目の合計が amount と合わなければ items を挙げる', () => {
    expect(fields({ ...base, items: [{ name: 'a', amount: 1000 }] })).toEqual(['items']);
  });

  it('金額は 1 以上 3 万以下の整数だけ', () => {
    expect(fields({ ...base, amount: 0 })).toEqual(['amount']);
    expect(fields({ ...base, amount: -1 })).toEqual(['amount']);
    expect(fields({ ...base, amount: 10.5 })).toEqual(['amount']);
    expect(fields({ ...base, amount: '1398' })).toEqual(['amount']);
    expect(fields({ ...base, amount: MAIL_MAX_AMOUNT + 1 })).toEqual(['amount']);
    expect(fields({ ...base, amount: MAIL_MAX_AMOUNT, items: null })).toEqual([]);
  });

  it('実在しない日付と形の違う日付を弾く', () => {
    expect(fields({ ...base, date: '2026-02-30' })).toEqual(['date']);
    expect(fields({ ...base, date: '2026/11/22' })).toEqual(['date']);
  });

  it('空の店名・内容・Message-ID と、source の違いを弾く', () => {
    expect(fields({ ...base, store: '  ', title: '', message_id: undefined, source: 'web' })).toEqual([
      'store',
      'title',
      'source',
      'message_id',
    ]);
  });

  it('注文番号は画面と同じ規則でそろえる（全角・ダッシュの揺れ）', () => {
    const parsed = parseMailDraft({ ...base, order_number: '２５０－４９１７８０７－１６１６６６０' });
    expect(parsed.ok && parsed.draft.orderNumber).toBe('250-4917807-1616660');
  });

  it('order_number は null を許すが、項目ごと無いのは弾く', () => {
    const parsed = parseMailDraft({ ...base, order_number: null });
    expect(parsed.ok && parsed.draft.orderNumber).toBeUndefined();
    const { order_number: _omit, ...without } = base;
    expect(fields(without)).toEqual(['order_number']);
  });

  it('品目の形が違えば、どの行のどの項目かを挙げる', () => {
    expect(fields({ ...base, items: [{ name: 'a', amount: 1398 }, { name: '', amount: 'x' }] })).toEqual([
      'items[1].name',
      'items[1].amount',
    ]);
    expect(fields({ ...base, items: [] })).toEqual(['items']);
    const many = Array.from({ length: MAIL_MAX_ITEMS + 1 }, () => ({ name: 'a', amount: 0 }));
    expect(fields({ ...base, items: many })).toEqual(['items']);
  });

  it('オブジェクトでない本文を弾く', () => {
    expect(fields(undefined)).toEqual(['body']);
    expect(fields([base])).toEqual(['body']);
  });
});

const draft: MailDraft = {
  date: '2026-11-22',
  store: 'Amazon',
  title: 'ティッシュ ほか',
  amount: 900,
  orderNumber: '250-1',
  messageId: '<m1@example>',
  items: [
    { name: 'ティッシュペーパー 5箱', amount: 1000 },
    { name: '割引', amount: -100 },
  ],
};

describe('receiptFromDraft', () => {
  it('未紐付けのメールのレシートにして、品目にキーワード表のカテゴリを当てる', () => {
    const receipt = receiptFromDraft(draft, 'r-1', new Date('2026-11-22T03:00:00Z'));
    expect(receipt).toMatchObject({
      id: 'r-1',
      storeName: 'Amazon',
      date: '2026-11-22',
      total: 900,
      currency: 'JPY',
      orderNumber: '250-1',
      source: 'mail',
      messageId: '<m1@example>',
      status: 'pending',
    });
    expect(receipt.items.map((item) => item.categoryId)).toEqual(['daily-consumables', 'discount']);
    // 内訳の合計は明細の金額と一致させる不変条件の入口。レシートの合計と品目の合計を揃えておく
    expect(receipt.items.reduce((sum, item) => sum + item.amount, 0)).toBe(receipt.total);
  });
});

describe('findExisting', () => {
  const receipt = (overrides: Partial<Receipt>): Receipt => ({
    id: 'r-x',
    storeName: 'Amazon',
    date: '2026-11-20',
    total: 900,
    items: [],
    status: 'pending',
    ...overrides,
  });

  it('同じ注文番号のレシート（画面で先に登録したものも）を返す', () => {
    expect(findExisting([receipt({ id: 'a', orderNumber: ' 250-1 ' })], draft)?.id).toBe('a');
  });

  it('同じメールから置いたレシートを返す', () => {
    expect(findExisting([receipt({ id: 'b', messageId: '<m1@example>' })], { ...draft, orderNumber: undefined })?.id).toBe('b');
  });

  it('注文番号が無いときは Message-ID だけで見る', () => {
    expect(findExisting([receipt({ orderNumber: '250-1' })], { ...draft, orderNumber: undefined })).toBeUndefined();
  });
});
