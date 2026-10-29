import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  DUPLICATE_STRONG_THRESHOLD,
  DUPLICATE_THRESHOLD,
  DUPLICATE_WEAK_THRESHOLD,
  duplicateKey,
  duplicatesInvolving,
  findDuplicateReceipts,
  findDuplicates,
  findDuplicatesOfDraft,
  isNotDuplicate,
  itemOverlap,
  markAllNotDuplicate,
  markNotDuplicate,
  normalizeOrderNumber,
  scoreDuplicate,
  strongDuplicates,
} from '../duplicate';
import { SEED_CATEGORIES } from '../categories';
import type { Receipt, Transaction } from '../types';

function txn(partial: Partial<Transaction> & { id: string; date: string; amount: number; rawMerchant: string }): Transaction {
  return {
    merchant: partial.rawMerchant,
    source: 'credit',
    sourceLabel: '楽天カード',
    splits: [{ id: `${partial.id}-1`, amount: partial.amount, categoryId: 'food', origin: 'rule' }],
    needsDetail: false,
    ...partial,
  };
}

function receipt(partial: Partial<Receipt> & { id: string; date: string; total: number; storeName: string }): Receipt {
  return { items: [], status: 'pending', ...partial };
}

/** 現金として保存したレシートの明細と、後から取り込んだカードの明細 */
const CASH = txn({
  id: 'cash1',
  date: '2026-09-01',
  amount: 1200,
  rawMerchant: 'セブン-イレブン品川駅前店',
  source: 'cash',
  sourceLabel: '現金',
  receiptId: 'r1',
});
const CARD = txn({ id: 'card1', date: '2026-09-03', amount: 1200, rawMerchant: 'セブン－イレブン品川' });

describe('findDuplicates', () => {
  it('現金レシートの明細と、後から取り込んだカード明細を候補に出す', () => {
    const pairs = findDuplicates([CASH, CARD]);
    expect(pairs).toHaveLength(1);
    expect(duplicateKey(pairs[0])).toBe('cash1:card1');
    expect(pairs[0].reasons).toContain('取り込み元が違う');
    expect(pairs[0].reasons).toContain('レシートが片方だけ');
  });

  it('金額が 1 円でも違えば候補に出ない', () => {
    expect(findDuplicates([CASH, { ...CARD, amount: 1201 }])).toEqual([]);
  });

  it('同じ金額の返金は支払いと組にならない', () => {
    const refund = txn({ id: 'refund1', date: '2026-09-02', amount: -1200, rawMerchant: 'セブン－イレブン品川' });
    expect(findDuplicates([CARD, refund])).toEqual([]);
  });

  it('日付が 5 日離れたら候補に出ない', () => {
    expect(findDuplicates([CASH, { ...CARD, date: '2026-09-06' }])).toEqual([]);
  });

  it('店が全く違う同額の組は、消さずに念のための候補へ下げる', () => {
    const other = txn({ id: 'other1', date: '2026-09-03', amount: 1200, rawMerchant: 'ドン・キホーテ' });
    const gasStation = txn({ id: 'other2', date: '2026-09-04', amount: 1200, rawMerchant: 'エネオス環七' });
    const pairs = findDuplicates([other, gasStation]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].strength).toBe('weak');
    expect(strongDuplicates(pairs)).toEqual([]);
  });

  it('現金レシートの明細とカード明細の組は強い候補', () => {
    expect(findDuplicates([CASH, CARD])[0].strength).toBe('strong');
  });

  it('手がかりが日付しか無く、4 日ずれた組は出さない', () => {
    const a = txn({ id: 'a', date: '2026-09-01', amount: 1200, rawMerchant: 'ドン・キホーテ' });
    const b = txn({ id: 'b', date: '2026-09-05', amount: 1200, rawMerchant: 'エネオス環七', splits: [{ id: 'b-1', amount: 1200, categoryId: 'transport', origin: 'rule' }] });
    expect(findDuplicates([a, b], SEED_CATEGORIES)).toEqual([]);
  });

  it('「重複ではない」と印を付けた組は次から出ない', () => {
    const [a, b] = markNotDuplicate(CASH, CARD);
    expect(findDuplicates([a, b])).toEqual([]);
  });

  it('印は片側だけ残っていても効く', () => {
    const [a] = markNotDuplicate(CASH, CARD);
    expect(findDuplicates([a, CARD])).toEqual([]);
    expect(findDuplicates([CASH, { ...CARD, notDuplicateOf: [CASH.id] }])).toEqual([]);
  });

  it('点数の高い順に並ぶ', () => {
    const near = txn({ id: 'card2', date: '2026-09-04', amount: 1200, rawMerchant: 'セブン－イレブン品川' });
    const pairs = findDuplicates([CASH, CARD, near]);
    expect(pairs.length).toBeGreaterThan(1);
    for (let index = 1; index < pairs.length; index += 1) {
      expect(pairs[index - 1].score).toBeGreaterThanOrEqual(pairs[index].score);
    }
  });

  it('金額でバケツに分けるので、関係ない明細が増えても組は変わらない', () => {
    const noise = Array.from({ length: 50 }, (_, index) =>
      txn({ id: `n${index}`, date: '2026-09-02', amount: 500 + index, rawMerchant: `店${index}` }),
    );
    expect(findDuplicates([...noise, CASH, CARD])).toHaveLength(1);
  });
});

describe('scoreDuplicate', () => {
  it('同じ日・同じ店・取り込み元違いは高く付く', () => {
    const a = txn({ id: 'a', date: '2026-09-01', amount: 800, rawMerchant: 'ローソン五反田' });
    const b = txn({ id: 'b', date: '2026-09-01', amount: 800, rawMerchant: 'ローソン五反田', source: 'paypay', sourceLabel: 'PayPay' });
    const pair = scoreDuplicate(a, b);
    expect(pair.score).toBe(110);
    expect(pair.reasons).toEqual(['同じ日', '店名が同じ', '取り込み元が違う', 'カテゴリが同じ']);
    expect(pair.strength).toBe('strong');
  });

  it('金額の一致は必須なので点には入れない', () => {
    const a = txn({ id: 'a', date: '2026-09-01', amount: 800, rawMerchant: 'ローソン' });
    expect(scoreDuplicate(a, { ...a, id: 'b' }).score).toBe(scoreDuplicate({ ...a, amount: 99 }, { ...a, id: 'b', amount: 99 }).score);
  });
});

/** 定期支払いから支払日に作った明細 */
function posted(id: string, paymentId: string, date: string, amount: number, rawMerchant: string, categoryId = 'oshi'): Transaction {
  return txn({
    id,
    date,
    amount,
    rawMerchant,
    source: 'manual',
    sourceLabel: '定期支払い',
    splits: [{ id: `${id}-1`, amount, categoryId, origin: 'manual' }],
    recurring: { paymentId, month: date.slice(0, 7) },
  });
}

describe('定期支払いとレシートの手がかり', () => {
  it('別の定期支払いから作った同日・同額の明細は、消さずに念のための候補にする', () => {
    const towa = posted('p1', 'rp-towa', '2026-10-05', 490, 'Towa Ch. 常闇トワ');
    const iroha = posted('p2', 'rp-iroha', '2026-10-05', 490, 'Iroha ch. 風真いろは');
    const pairs = findDuplicates([towa, iroha]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].score).toBe(30);
    expect(pairs[0].strength).toBe('weak');
    expect(pairs[0].reasons).toEqual(['同じ日', 'カテゴリが同じ', '別の定期支払い']);
  });

  it('作った明細には、取り込み元の違いとレシートの有無で点を足さない', () => {
    const ramen = txn({
      id: 'ramen',
      date: '2026-09-30',
      amount: 1000,
      rawMerchant: '焼きあご塩らー麺たかはし',
      source: 'cash',
      sourceLabel: '現金',
      receiptId: 'r-ramen',
      splits: [{ id: 'ramen-1', amount: 1000, categoryId: 'food', origin: 'receipt' }],
    });
    const support = posted('p1', 'rp-pixiv', '2026-10-01', 1000, 'ふみひこさんへの支援');
    const [pair] = findDuplicates([ramen, support]);
    expect(pair.score).toBe(30);
    expect(pair.strength).toBe('weak');
    expect(pair.reasons).not.toContain('取り込み元が違う');
    expect(pair.reasons).not.toContain('レシートが片方だけ');
  });

  it('作った明細と、店名の書き方が違うカード明細は強い候補', () => {
    const netflix = posted('p1', 'rp-netflix', '2026-10-05', 1590, 'Netflix', 'fees');
    const card = txn({
      id: 'card',
      date: '2026-10-05',
      amount: 1590,
      rawMerchant: 'ＮＦ＊ＭＥＭＢＥＲＳＨＩＰ',
      splits: [{ id: 'card-1', amount: 1590, categoryId: 'fees', origin: 'rule' }],
    });
    const [pair] = findDuplicates([netflix, card]);
    expect(pair.score).toBe(70);
    expect(pair.strength).toBe('strong');
    expect(pair.reasons).toContain('定期支払いと利用明細');
  });

  it('別々のレシートが両方に付いた組は下げる', () => {
    const a = { ...CASH, id: 'a', receiptId: 'r1' };
    const b = { ...CASH, id: 'b', receiptId: 'r2' };
    const [pair] = findDuplicates([a, b]);
    expect(pair.reasons).toContain('別々のレシート');
    expect(pair.score).toBe(scoreDuplicate(a, { ...b, receiptId: 'r1' }).score - 20);
  });

  it('カテゴリは小カテゴリを親に寄せて比べ、未分類どうしは数えない', () => {
    const child = SEED_CATEGORIES.find((category) => category.parentId !== undefined)!;
    const a = txn({ id: 'a', date: '2026-09-01', amount: 500, rawMerchant: 'A', splits: [{ id: 'a-1', amount: 500, categoryId: child.id, origin: 'rule' }] });
    const b = txn({ id: 'b', date: '2026-09-01', amount: 500, rawMerchant: 'B', splits: [{ id: 'b-1', amount: 500, categoryId: child.parentId!, origin: 'rule' }] });
    expect(scoreDuplicate(a, b, SEED_CATEGORIES).reasons).toContain('カテゴリが同じ');
    expect(scoreDuplicate(a, b).reasons).not.toContain('カテゴリが同じ');

    const blank = (id: string) => txn({ id, date: '2026-09-01', amount: 500, rawMerchant: id, splits: [{ id: `${id}-1`, amount: 500, categoryId: 'uncategorized', origin: 'fallback' }] });
    expect(scoreDuplicate(blank('x'), blank('y')).reasons).not.toContain('カテゴリが同じ');
  });

  it('しきい値は念のため < レシートの下限 < 強い候補', () => {
    expect(DUPLICATE_WEAK_THRESHOLD).toBeLessThan(DUPLICATE_THRESHOLD);
    expect(DUPLICATE_THRESHOLD).toBeLessThan(DUPLICATE_STRONG_THRESHOLD);
  });
});

describe('markAllNotDuplicate', () => {
  it('同じ明細が何組に出ていても、印を全部残して 1 件にまとめる', () => {
    const a = txn({ id: 'a', date: '2026-09-01', amount: 500, rawMerchant: 'A' });
    const b = txn({ id: 'b', date: '2026-09-01', amount: 500, rawMerchant: 'B' });
    const c = txn({ id: 'c', date: '2026-09-02', amount: 500, rawMerchant: 'C' });
    const updated = markAllNotDuplicate(findDuplicates([a, b, c]));
    expect(updated).toHaveLength(3);
    expect(findDuplicates(updated)).toEqual([]);
    expect(updated.find((t) => t.id === 'a')?.notDuplicateOf?.sort()).toEqual(['b', 'c']);
  });
});

describe('markNotDuplicate', () => {
  it('両側に相手の ID を入れる', () => {
    const [a, b] = markNotDuplicate(CASH, CARD);
    expect(a.notDuplicateOf).toEqual(['card1']);
    expect(b.notDuplicateOf).toEqual(['cash1']);
    expect(isNotDuplicate(a, b)).toBe(true);
  });

  it('二度押しても増えない', () => {
    const [once, twice] = markNotDuplicate(...markNotDuplicate(CASH, CARD));
    expect(once.notDuplicateOf).toEqual(['card1']);
    expect(twice.notDuplicateOf).toEqual(['cash1']);
  });

  it('元の明細は書き換えない', () => {
    markNotDuplicate(CASH, CARD);
    expect(CASH.notDuplicateOf).toBeUndefined();
  });
});

describe('duplicatesInvolving', () => {
  it('指定した明細が絡む組だけ残す', () => {
    const pairs = findDuplicates([CASH, CARD]);
    expect(duplicatesInvolving(pairs, ['card1'])).toHaveLength(1);
    expect(duplicatesInvolving(pairs, ['よその明細'])).toEqual([]);
  });
});

describe('findDuplicateReceipts', () => {
  const first = receipt({
    id: 'r1',
    date: '2026-09-01',
    total: 1200,
    storeName: 'セブン-イレブン品川駅前店',
    items: [{ name: 'おにぎり', amount: 700 }, { name: 'お茶', amount: 500 }],
  });

  it('同じレシートを 2 回撮ったものを拾う', () => {
    const second = receipt({ ...first, id: 'r2' });
    const pairs = findDuplicateReceipts([first, second]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].reasons).toContain('品目まで同じ');
  });

  it('合計が違えば拾わない', () => {
    expect(findDuplicateReceipts([first, receipt({ ...first, id: 'r2', total: 1300 })])).toEqual([]);
  });

  it('捨てたレシートは相手にしない', () => {
    expect(findDuplicateReceipts([first, receipt({ ...first, id: 'r2', status: 'discarded' })])).toEqual([]);
  });

  it('同じ店の別の日の買い物は拾わない', () => {
    expect(findDuplicateReceipts([first, receipt({ ...first, id: 'r2', date: '2026-09-20' })])).toEqual([]);
  });

  it('同じ日・同じ店・同じ合計でも、品目が違えば別の会計として拾わない', () => {
    const order1 = receipt({ id: 'a1', date: '2026-09-02', total: 572, storeName: 'Amazon', items: [{ name: '単三電池 4本', amount: 572 }] });
    const order2 = receipt({ id: 'a2', date: '2026-09-02', total: 572, storeName: 'Amazon', items: [{ name: 'キッチンペーパー', amount: 572 }] });
    expect(findDuplicateReceipts([order1, order2])).toEqual([]);
  });

  it('撮り直しで品目名の読みが少し揺れても同じレシートとして拾う', () => {
    const second = receipt({ ...first, id: 'r2', items: [{ name: 'おにぎり 鮭', amount: 700 }, { name: 'お茶', amount: 500 }] });
    const pairs = findDuplicateReceipts([first, second]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].reasons).toContain('品目まで同じ');
  });

  it('品目が半分だけ重なる組は、拾うが「一部同じ」と添える', () => {
    const second = receipt({ ...first, id: 'r2', items: [{ name: 'おにぎり', amount: 700 }, { name: 'パン', amount: 500 }] });
    const pairs = findDuplicateReceipts([first, second]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].reasons).toContain('品目が一部同じ');
  });

  it('品目が片方に無ければ、店名と日付だけで判断する', () => {
    expect(findDuplicateReceipts([first, receipt({ ...first, id: 'r2', items: [] })])).toHaveLength(1);
  });

  it('「別の買い物」と言われた組は二度と出さない', () => {
    const second = receipt({ ...first, id: 'r2' });
    const [a, b] = markNotDuplicate(first, second);
    expect(a.notDuplicateOf).toEqual(['r2']);
    expect(b.notDuplicateOf).toEqual(['r1']);
    expect(findDuplicateReceipts([a, b])).toEqual([]);
    // 片側だけ印が残っていても出さない
    expect(findDuplicateReceipts([a, second])).toEqual([]);
  });
});

describe('注文番号', () => {
  const order = receipt({
    id: 'o1',
    date: '2026-09-02',
    total: 3480,
    storeName: 'Amazon.co.jp',
    orderNumber: '250-1234567-1234567',
    items: [{ name: 'USB-C ケーブル 2本組', amount: 3480 }],
  });

  it('全角や空白を寄せて比べられる形にし、数字の無いものは番号とみなさない', () => {
    expect(normalizeOrderNumber(' ２５０－１２３４５６７－１２３４５６７ ')).toBe('250-1234567-1234567');
    expect(normalizeOrderNumber('d01-1234567-1234567')).toBe('D01-1234567-1234567');
    expect(normalizeOrderNumber('なし')).toBeUndefined();
  });

  it('同じ番号なら、日付が離れていても品目の読みが違っても候補に出す', () => {
    const later = receipt({ ...order, id: 'o2', date: '2026-09-10', items: [{ name: 'ケーブル', amount: 3480 }] });
    const pairs = findDuplicateReceipts([order, later]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].reasons[0]).toBe('注文番号が同じ');
  });

  it('番号が違えば、同じ日・同じ店・同じ合計でも別の注文として出さない', () => {
    const other = receipt({ ...order, id: 'o2', orderNumber: '250-7654321-7654321', items: [{ name: 'USB-C ケーブル', amount: 3480 }] });
    expect(findDuplicateReceipts([order, { ...other, items: [{ name: 'マウス', amount: 3480 }] }])).toEqual([]);
    // 番号が無ければ拾う「品目が一部同じ」組も、番号が違えば別の注文と言い切る
    const two = { ...order, items: [{ name: '電池', amount: 1000 }, { name: 'マウス', amount: 2480 }] };
    const half = { ...other, items: [{ name: '電池', amount: 1000 }, { name: 'キーボード', amount: 2480 }] };
    expect(findDuplicateReceipts([{ ...two, orderNumber: undefined }, half])).toHaveLength(1);
    expect(findDuplicateReceipts([two, half])).toEqual([]);
  });

  it('番号が違っても品目まで全部同じなら、番号の読み違いを疑って候補に残す', () => {
    const misread = receipt({ ...order, id: 'o2', orderNumber: '250-1234567-1234561' });
    const pairs = findDuplicateReceipts([order, misread]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].reasons).toContain('品目まで同じ');
    expect(pairs[0].reasons).not.toContain('注文番号が同じ');
  });

  it('片方にしか番号が無ければ、これまでと同じ判定', () => {
    const plain = receipt({ ...order, id: 'o2', orderNumber: undefined });
    expect(findDuplicateReceipts([order, plain])).toHaveLength(1);
    expect(findDuplicateReceipts([order, { ...plain, date: '2026-09-10' }])).toEqual([]);
  });
});

describe('findDuplicatesOfDraft', () => {
  const saved = receipt({ id: 'r1', date: '2026-09-02', total: 572, storeName: 'Amazon', items: [{ name: '単三電池', amount: 572 }] });
  const draft = receipt({ ...saved, id: 'r-draft' });

  it('下書きと同じかもしれない保存済みを、下書きを a にして返す', () => {
    const pairs = findDuplicatesOfDraft(draft, [saved]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].a.id).toBe('r-draft');
    expect(pairs[0].b.id).toBe('r1');
  });

  it('保存済みどうしの組は返さない', () => {
    const other = receipt({ ...saved, id: 'r0', date: '2026-09-01' });
    const fresh = receipt({ ...draft, total: 1000, items: [] });
    expect(findDuplicateReceipts([other, saved])).toHaveLength(1);
    expect(findDuplicatesOfDraft(fresh, [other, saved])).toEqual([]);
  });

  it('開いて直している保存済み（同じ ID）とは組にしない', () => {
    expect(findDuplicatesOfDraft({ ...saved }, [saved])).toEqual([]);
  });

  it('保存後の判定と同じ組を出す。保存前に出なかったものは保存後にも出ない', () => {
    fc.assert(
      fc.property(fc.integer({ min: -6, max: 6 }), fc.boolean(), fc.string({ maxLength: 8 }), (shift, sameItems, name) => {
        const day = 10 + shift;
        const candidate = receipt({
          ...draft,
          date: `2026-09-${String(day).padStart(2, '0')}`,
          storeName: name,
          items: sameItems ? draft.items : [{ name: 'キッチンペーパー', amount: 572 }],
        });
        const base = receipt({ ...saved, date: '2026-09-10' });
        const before = findDuplicatesOfDraft(candidate, [base]).map((pair) => [pair.a.id, pair.b.id].sort().join(':'));
        const after = findDuplicateReceipts([candidate, base]).map((pair) => [pair.a.id, pair.b.id].sort().join(':'));
        expect(before).toEqual(after);
      }),
    );
  });
});

describe('itemOverlap', () => {
  const base = receipt({ id: 'x', date: '2026-09-01', total: 300, storeName: 'S', items: [{ name: 'A', amount: 100 }, { name: 'B', amount: 200 }] });

  it('品目が無ければ材料なし', () => {
    expect(itemOverlap(base, { ...base, items: [] })).toBeUndefined();
  });

  it('同じ金額の品目でも 1 対 1 でしか当てない', () => {
    const twice = { ...base, items: [{ name: 'A', amount: 100 }, { name: 'A', amount: 100 }, { name: 'B', amount: 100 }] };
    expect(itemOverlap({ ...base, items: [{ name: 'A', amount: 100 }] }, twice)).toBeCloseTo(1 / 3);
  });

  it('名前が同じでも金額が違えば当てない', () => {
    expect(itemOverlap(base, { ...base, items: [{ name: 'A', amount: 150 }, { name: 'B', amount: 150 }] })).toBe(0);
  });
});

describe('プロパティ', () => {
  const day = fc.integer({ min: 1, max: 28 }).map((value) => `2026-09-${String(value).padStart(2, '0')}`);
  const merchant = fc.string({ minLength: 1, maxLength: 20 });
  const amount = fc.integer({ min: -500_000, max: 500_000 });

  it('同じ内容の明細が 2 件あれば必ず候補に出る', () => {
    fc.assert(
      fc.property(day, amount, merchant, (date, value, rawMerchant) => {
        const a = txn({ id: 'a', date, amount: value, rawMerchant });
        const pairs = findDuplicates([a, { ...a, id: 'b', splits: [{ ...a.splits[0], id: 'b-1' }] }]);
        expect(pairs).toHaveLength(1);
        expect(pairs[0].score).toBeGreaterThanOrEqual(DUPLICATE_THRESHOLD);
      }),
    );
  });

  it('金額が違えば、他が全部同じでも候補に出ない', () => {
    fc.assert(
      fc.property(day, amount, amount, merchant, (date, left, right, rawMerchant) => {
        fc.pre(left !== right);
        const a = txn({ id: 'a', date, amount: left, rawMerchant });
        const b = txn({ id: 'b', date, amount: right, rawMerchant, splits: [{ id: 'b-1', amount: right, categoryId: 'food', origin: 'rule' }] });
        expect(findDuplicates([a, b])).toEqual([]);
      }),
    );
  });

  it('渡す順を入れ替えても同じ組が出る', () => {
    fc.assert(
      fc.property(day, day, amount, merchant, merchant, (leftDate, rightDate, value, leftName, rightName) => {
        const a = txn({ id: 'a', date: leftDate, amount: value, rawMerchant: leftName });
        const b = txn({ id: 'b', date: rightDate, amount: value, rawMerchant: rightName });
        expect(findDuplicates([a, b]).map(duplicateKey)).toEqual(findDuplicates([b, a]).map(duplicateKey));
      }),
    );
  });
});
