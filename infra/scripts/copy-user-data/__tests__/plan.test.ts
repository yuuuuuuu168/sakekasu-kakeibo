import { describe, expect, it } from 'vitest';
import { assertSubs, findString, parseArgs, receiptPrefix, rewriteItem, rewriteObjectKey, userPk } from '../plan';

const OLD = '11111111-2222-4333-8444-555555555555';
const NEW = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

describe('assertSubs', () => {
  it('UUID の組なら通す', () => {
    expect(() => assertSubs(OLD, NEW)).not.toThrow();
  });

  /* ユーザー名やメールを渡すと、どこにも当たらず「0 件」で終わって気づきにくい */
  it('UUID でなければ落とす', () => {
    expect(() => assertSubs('me', NEW)).toThrow(/--from/);
    expect(() => assertSubs(OLD, 'me@example.com')).toThrow(/--to/);
  });

  it('同じ sub なら落とす', () => {
    expect(() => assertSubs(OLD, OLD)).toThrow(/同じ/);
  });
});

describe('rewriteObjectKey', () => {
  it('旧 sub の下のキーを新 sub の下に付け替える', () => {
    expect(rewriteObjectKey(`receipts/${OLD}/2026-09-01/x.jpg`, OLD, NEW)).toBe(`receipts/${NEW}/2026-09-01/x.jpg`);
  });

  it('旧 sub の下でなければ付け替えない', () => {
    expect(rewriteObjectKey(`receipts/${NEW}/2026-09-01/x.jpg`, OLD, NEW)).toBeUndefined();
    expect(rewriteObjectKey(`other/${OLD}/x.jpg`, OLD, NEW)).toBeUndefined();
    // 前方一致の取り違え（sub の後ろに文字が続く）を拾わない
    expect(rewriteObjectKey(`receipts/${OLD}x/x.jpg`, OLD, NEW)).toBeUndefined();
  });
});

describe('rewriteItem', () => {
  it('pk を付け替え、sk とほかの値はそのまま写す', () => {
    const source = { pk: userPk(OLD), sk: 'TXN#abc', amount: 1200, splits: [{ categoryId: 'food', amount: 1200 }] };
    const { item, leftovers } = rewriteItem(source, OLD, NEW);
    expect(item).toEqual({ ...source, pk: userPk(NEW) });
    expect(leftovers).toEqual([]);
  });

  it('レシートの imageKey を新 sub の下に付け替える', () => {
    const source = {
      pk: userPk(OLD),
      sk: 'RECEIPT#r1',
      imageKey: `${receiptPrefix(OLD)}2026-09-01/r1.jpg`,
      items: [{ name: 'おにぎり', price: 150 }],
    };
    const { item, leftovers } = rewriteItem(source, OLD, NEW);
    expect(item.imageKey).toBe(`${receiptPrefix(NEW)}2026-09-01/r1.jpg`);
    expect(item.pk).toBe(userPk(NEW));
    expect(leftovers).toEqual([]);
  });

  it('元の項目を書き換えない', () => {
    const source = { pk: userPk(OLD), sk: 'RECEIPT#r1', imageKey: `${receiptPrefix(OLD)}a.jpg` };
    rewriteItem(source, OLD, NEW);
    expect(source.pk).toBe(userPk(OLD));
    expect(source.imageKey).toBe(`${receiptPrefix(OLD)}a.jpg`);
  });

  /* 規則に無い場所に旧 sub が入っていたら、黙って写さずに知らせる */
  it('付け替えた後も旧 sub が残る場所を返す', () => {
    const source = { pk: userPk(OLD), sk: 'CONFIG#rules', rules: [{ note: `owner ${OLD}` }], [OLD]: 1 };
    const { leftovers } = rewriteItem(source, OLD, NEW);
    expect(leftovers).toContain('rules[0].note');
    expect(leftovers).toContain(`${OLD}（キー名）`);
  });

  it('pk が旧 sub のものでなければ落とす', () => {
    expect(() => rewriteItem({ pk: userPk(NEW), sk: 'TXN#a' }, OLD, NEW)).toThrow(/pk/);
  });
});

describe('findString', () => {
  it('入れ子の配列とオブジェクトを辿る', () => {
    expect(findString({ a: [{ b: 'xx-needle' }, 'no'], c: 1 }, 'needle')).toEqual(['a[0].b']);
  });
});

describe('parseArgs', () => {
  const base = ['--table', 't', '--bucket', 'b', '--from', OLD, '--to', NEW];

  it('既定は dry-run で ap-northeast-1', () => {
    expect(parseArgs(base)).toEqual({ table: 't', bucket: 'b', from: OLD, to: NEW, region: 'ap-northeast-1', apply: false });
  });

  it('--apply で書き込みにする', () => {
    expect(parseArgs([...base, '--apply']).apply).toBe(true);
  });

  it('--skip-s3 ならバケットなしで通す', () => {
    expect(parseArgs(['--table', 't', '--from', OLD, '--to', NEW, '--skip-s3']).bucket).toBeUndefined();
  });

  it('足りない・知らない引数は落とす', () => {
    expect(() => parseArgs(['--table', 't', '--from', OLD, '--to', NEW])).toThrow(/--bucket/);
    expect(() => parseArgs(['--bucket', 'b', '--from', OLD, '--to', NEW])).toThrow(/--table/);
    expect(() => parseArgs([...base, '--force'])).toThrow(/知らない引数/);
    expect(() => parseArgs(['--table', '--bucket', 'b', '--from', OLD, '--to', NEW])).toThrow(/値がありません/);
  });
});
