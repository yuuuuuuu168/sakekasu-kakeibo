import { beforeAll, describe, expect, it } from 'vitest';
import { MAX_RECEIPT_PHOTOS } from '@kakeibo/core';

/** モジュールの読み込み時に環境変数を見るので、先に置いてから動的に読み込む */
let parseKeys: typeof import('../index')['parseKeys'];

beforeAll(async () => {
  process.env.RECEIPT_BUCKET = 'test-bucket';
  process.env.BEDROCK_MODEL_ID = 'test-model';
  parseKeys = (await import('../index')).parseKeys;
});

const mine = (name: string) => `receipts/user-1/2026-10-10/${name}.jpg`;

describe('parseKeys', () => {
  it('1 枚のときは key をそのまま読む（これまでの呼び方）', () => {
    expect(parseKeys({ key: mine('a') }, 'user-1')).toEqual({ keys: [mine('a')] });
  });

  it('分けて撮ったレシートは keys を順番のまま読む', () => {
    expect(parseKeys({ keys: [mine('b'), mine('a')] }, 'user-1')).toEqual({ keys: [mine('b'), mine('a')] });
  });

  it('キーが無い・空・文字列でないものが混ざっていれば断る', () => {
    expect(parseKeys({}, 'user-1')).toMatchObject({ status: 400 });
    expect(parseKeys({ keys: [] }, 'user-1')).toMatchObject({ status: 400 });
    expect(parseKeys({ keys: [mine('a'), 3] }, 'user-1')).toMatchObject({ status: 400 });
  });

  it('上限より多い枚数や、同じ写真の重複は断る', () => {
    const many = Array.from({ length: MAX_RECEIPT_PHOTOS + 1 }, (_, index) => mine(`p${index}`));
    expect(parseKeys({ keys: many }, 'user-1')).toMatchObject({ status: 400 });
    expect(parseKeys({ keys: [mine('a'), mine('a')] }, 'user-1')).toMatchObject({ status: 400 });
  });

  it('1 枚でも他人の写真が混ざっていれば読ませない', () => {
    expect(parseKeys({ keys: [mine('a'), 'receipts/user-2/2026-10-10/x.jpg'] }, 'user-1')).toMatchObject({
      status: 403,
      keys: ['receipts/user-2/2026-10-10/x.jpg'],
    });
    expect(parseKeys({ key: 'receipts/user-10/x.jpg' }, 'user-1')).toMatchObject({ status: 403 });
  });
});
