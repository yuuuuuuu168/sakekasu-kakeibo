import { beforeAll, describe, expect, it } from 'vitest';

/** モジュールの読み込み時に環境変数を見るので、先に置いてから動的に読み込む */
let parseTarget: typeof import('../index')['parseTarget'];
let buildState: typeof import('../index')['buildState'];
let toAnswers: typeof import('../index')['toAnswers'];

const CATEGORIES = [
  { id: 'food', label: '食費', order: 1 },
  { id: 'daily', label: '日用品', order: 5 },
  { id: 'rice', label: '米・パン', order: 101, parentId: 'food' },
];

beforeAll(async () => {
  process.env.TYPESAFE_SECRET_ID = 'test-secret';
  process.env.TYPESAFE_MODEL_ID = 'test-model';
  const module = await import('../index');
  parseTarget = module.parseTarget;
  buildState = module.buildState;
  toAnswers = module.toAnswers;
});

describe('parseTarget', () => {
  it('品目と店舗名の 2 種類を受ける。既定は品目', () => {
    const body = { subjects: [{ key: 's0', text: 'おにぎり' }], categories: CATEGORIES };
    expect(parseTarget(body)?.kind).toBe('item');
    expect(parseTarget({ ...body, kind: 'merchant' })?.kind).toBe('merchant');
    expect(parseTarget({ ...body, kind: 'なにか' })?.kind).toBe('item');
  });

  it('小カテゴリの親をそのまま持ち越す', () => {
    const target = parseTarget({ subjects: [{ key: 's0', text: 'おにぎり' }], categories: CATEGORIES });
    expect(target?.categories.find((category) => category.id === 'rice')?.parentId).toBe('food');
  });

  it('前後の空白を落とし、空の品目は捨てる', () => {
    const target = parseTarget({
      subjects: [
        { key: 's0', text: '  おにぎり  ', context: ' セブン ' },
        { key: 's1', text: '   ' },
        { key: '', text: 'ティッシュ' },
      ],
      categories: CATEGORIES,
    });
    expect(target?.subjects).toEqual([{ key: 's0', text: 'おにぎり', context: 'セブン' }]);
  });

  it('同じ名前の質問は 1 つだけ通す', () => {
    const target = parseTarget({
      subjects: [
        { key: 's0', text: 'おにぎり' },
        { key: 's0', text: 'ティッシュ' },
      ],
      categories: CATEGORIES,
    });
    expect(target?.subjects).toHaveLength(1);
  });

  it('多すぎる対象は 100 件で切る', () => {
    const subjects = Array.from({ length: 150 }, (_, index) => ({ key: `s${index}`, text: `品目${index}` }));
    expect(parseTarget({ subjects, categories: CATEGORIES })?.subjects).toHaveLength(100);
  });

  it('order が無いカテゴリも受ける', () => {
    const target = parseTarget({ subjects: [{ key: 's0', text: 'おにぎり' }], categories: [{ id: 'food', label: '食費' }] });
    expect(target?.categories[0].order).toBe(0);
  });

  it('対象かカテゴリが空なら受けない', () => {
    expect(parseTarget({ subjects: [], categories: CATEGORIES })).toBeUndefined();
    expect(parseTarget({ subjects: [{ key: 's0', text: 'おにぎり' }], categories: [] })).toBeUndefined();
    expect(parseTarget({})).toBeUndefined();
  });

  it('形の違う要素は捨てる', () => {
    const target = parseTarget({
      subjects: ['おにぎり', null, { key: 's0', text: 'おにぎり' }],
      categories: [null, 'food', { id: 'food', label: '食費', order: 1 }, { id: 'broken' }],
    });
    expect(target?.subjects).toHaveLength(1);
    expect(target?.categories).toHaveLength(1);
  });
});

describe('buildState', () => {
  it('対象を全部入れる。1 品目の判断を他の品目が助ける', () => {
    const target = parseTarget({
      subjects: [
        { key: 's0', text: '惣菜', context: 'イトーヨーカドー' },
        { key: 's1', text: '洗剤' },
      ],
      categories: CATEGORIES,
    })!;
    const state = buildState(target) as { 種類: string; 対象: Record<string, unknown>[] };
    expect(state.種類).toContain('レシート');
    expect(state.対象).toEqual([
      { 番号: 's0', 内容: '惣菜', 店舗名: 'イトーヨーカドー' },
      { 番号: 's1', 内容: '洗剤' },
    ]);
  });

  it('店舗名の判定だと種類が変わる', () => {
    const target = parseTarget({ kind: 'merchant', subjects: [{ key: 'm0', text: 'ローソン' }], categories: CATEGORIES })!;
    expect((buildState(target) as { 種類: string }).種類).toContain('明細');
  });
});

describe('toAnswers', () => {
  it('選んだラベルと確信度だけ取り出す', () => {
    const answers = toAnswers({
      s0: { type: 'choice', choice: 'food', confidence: 0.94, probabilities: { food: 0.94, daily: 0.06 } },
    });
    expect(answers).toEqual({ s0: { choice: 'food', confidence: 0.94 } });
  });

  it('形の違う答えは捨てる', () => {
    expect(
      toAnswers({
        ok: { choice: 'food', confidence: 0.9 },
        noChoice: { confidence: 0.9 },
        noConfidence: { choice: 'food' },
        nan: { choice: 'food', confidence: Number.NaN },
        empty: { choice: '', confidence: 0.9 },
        noul: 0.4,
        nil: null,
      }),
    ).toEqual({ ok: { choice: 'food', confidence: 0.9 } });
  });

  it('確信度は 0 と 1 の間に収める', () => {
    const answers = toAnswers({ a: { choice: 'food', confidence: 1.4 }, b: { choice: 'food', confidence: -0.2 } });
    expect(answers.a.confidence).toBe(1);
    expect(answers.b.confidence).toBe(0);
  });

  it('答えが無くても落ちない', () => {
    expect(toAnswers(undefined)).toEqual({});
    expect(toAnswers('answers')).toEqual({});
  });
});
