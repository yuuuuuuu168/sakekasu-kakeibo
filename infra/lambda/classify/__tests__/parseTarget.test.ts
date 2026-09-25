import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { AskClient } from '../index';

/** モジュールの読み込み時に環境変数を見るので、先に置いてから動的に読み込む */
let parseTarget: typeof import('../index')['parseTarget'];
let buildState: typeof import('../index')['buildState'];
let toAnswers: typeof import('../index')['toAnswers'];
let ask: typeof import('../index')['ask'];
let describeFailure: typeof import('../index')['describeFailure'];

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
  ask = module.ask;
  describeFailure = module.describeFailure;
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

  /*
   * 問いの大きさは対象の数 × カテゴリの数 × 文字の長さで膨らみ、そのまま料金になる。
   * 対象の数だけ切っても、カテゴリや名前を長く大量に送られると青天井になる
   */
  it('多すぎるカテゴリと長すぎる文字列は切る', () => {
    const categories = Array.from({ length: 500 }, (_, index) => ({ id: `c${index}`, label: 'あ'.repeat(1000) }));
    const subjects = [{ key: 's0', text: 'い'.repeat(1000), context: 'う'.repeat(1000) }];
    const target = parseTarget({ subjects, categories });
    expect(target?.categories).toHaveLength(200);
    expect(target?.categories[0].label).toHaveLength(50);
    expect(target?.subjects[0].text).toHaveLength(200);
    expect(target?.subjects[0].context).toHaveLength(200);
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

describe('ask', () => {
  const specs = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      name: `s${index}`,
      instructions: `質問${index}`,
      criteria: { food: '食費', daily: '日用品' },
    }));

  /** 質問の名前ごとに food を高い確信度で返す、Jev の代わり */
  function fakeClient(onCall?: (batch: string[]) => Promise<unknown> | undefined) {
    const calls: string[][] = [];
    const systemOne = vi.fn((request: { questions: Record<string, unknown> }) => {
      const names = Object.keys(request.questions);
      calls.push(names);
      const override = onCall?.(names);
      if (override) return override;
      return Promise.resolve({
        answers: Object.fromEntries(names.map((name) => [name, { type: 'choice', choice: 'food', confidence: 0.9 }])),
      });
    });
    return { client: { systemOne } as unknown as AskClient, calls, systemOne };
  }

  it('質問を 20 問ずつの束に切る', async () => {
    const { client, calls } = fakeClient();
    const answers = await ask(client, {}, specs(45));
    expect(calls.map((batch) => batch.length)).toEqual([20, 20, 5]);
    expect(Object.keys(answers)).toHaveLength(45);
  });

  it('束は同時に投げる（直列にすると Lambda の制限時間を超える）', async () => {
    let running = 0;
    let peak = 0;
    const { client } = fakeClient(async (names) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return { answers: Object.fromEntries(names.map((name) => [name, { choice: 'food', confidence: 0.9 }])) };
    });

    await ask(client, {}, specs(60));
    expect(peak).toBe(3);
  });

  it('束が 1 つ落ちても残りの答えは活きる', async () => {
    const { client } = fakeClient((names) => (names.includes('s0') ? Promise.reject(new Error('429')) : undefined));
    const answers = await ask(client, {}, specs(40));
    expect(answers.s0).toBeUndefined();
    expect(answers.s20).toEqual({ choice: 'food', confidence: 0.9 });
  });

  it('全部落ちたら投げ直す（判定できなかったことを黙らせない）', async () => {
    const { client } = fakeClient(() => Promise.reject(new Error('鍵が違う')));
    await expect(ask(client, {}, specs(40))).rejects.toThrow('鍵が違う');
  });

  it('質問が無ければ呼ばない', async () => {
    const { client, systemOne } = fakeClient();
    expect(await ask(client, {}, [])).toEqual({});
    expect(systemOne).not.toHaveBeenCalled();
  });
});

describe('describeFailure', () => {
  it('例外から要るものだけ取り出す（そのままログに流さない）', () => {
    expect(describeFailure(new Error('落ちた'))).toBe('Error: 落ちた');
    expect(describeFailure(Object.assign(new Error('多すぎ'), { name: 'RateLimitError', status: 429 }))).toBe(
      'RateLimitError(429): 多すぎ',
    );
    expect(describeFailure('文字列')).toBe('不明な失敗');
    expect(describeFailure(undefined)).toBe('不明な失敗');
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
