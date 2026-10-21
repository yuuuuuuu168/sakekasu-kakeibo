import { beforeAll, describe, expect, it } from 'vitest';
import type { Receipt } from '@kakeibo/core';

let parseRequest: typeof import('../index')['parseRequest'];
let selectSamples: typeof import('../index')['selectSamples'];
let isSpendLimit: typeof import('../index')['isSpendLimit'];
let summarize: typeof import('../index')['summarize'];
let overBudget: typeof import('../index')['overBudget'];

beforeAll(async () => {
  process.env.TABLE_NAME = 'test-table';
  process.env.RECEIPT_BUCKET = 'test-bucket';
  process.env.TYPESAFE_SECRET_ID = 'test-secret';
  process.env.TYPESAFE_MODEL_ID = 'test-model';
  ({ parseRequest, selectSamples, isSpendLimit, summarize, overBudget } = await import('../index'));
});

describe('parseRequest', () => {
  it('既定を埋める（effort は本番の OCR と同じ low）', () => {
    expect(parseRequest({ task: 'ocr', model: 'claude-opus-5-5' })).toEqual({
      task: 'ocr',
      model: 'claude-opus-5-5',
      effort: 'low',
      offset: 0,
      limit: 20,
      maxUsd: 5,
      parallel: 3,
      label: 'ocr:claude-opus-5-5:low',
    });
  });

  it('予算・枚数・並列の数は天井で止める', () => {
    expect(parseRequest({ task: 'ocr', model: 'claude-fable-5-1', maxUsd: 500, limit: 10_000, parallel: 99 })).toMatchObject({
      maxUsd: 50,
      limit: 300,
      parallel: 8,
    });
  });

  it('料金の分からないモデルは、price が無ければ走らせない', () => {
    expect(parseRequest({ task: 'ocr', model: 'claude-fable-5-5' })).toHaveProperty('error');
    expect(parseRequest({ task: 'ocr', model: 'claude-fable-5-5', price: { input: 10, output: 50 } })).toMatchObject({
      price: { input: 10, output: 50 },
    });
  });

  it('jev と keywords はカテゴリ判定だけ', () => {
    expect(parseRequest({ task: 'classify', model: 'jev' })).toMatchObject({ model: 'jev' });
    expect(parseRequest({ task: 'ocr', model: 'jev' })).toHaveProperty('error');
    expect(parseRequest({ task: 'classify', model: 'gpt-x' })).toHaveProperty('error');
  });

  it('知らない effort と仕事は弾く', () => {
    expect(parseRequest({ task: 'ocr', model: 'claude-opus-5-5', effort: 'ultra' })).toHaveProperty('error');
    expect(parseRequest({ task: 'summary', model: 'claude-opus-5-5' })).toHaveProperty('error');
  });
});

describe('selectSamples', () => {
  const owner = { categories: [], rules: [] };
  const receipt = (id: string, date: string, extra: Partial<Receipt> = {}): { receipt: Receipt; owner: typeof owner } => ({
    receipt: {
      id,
      storeName: '店',
      date,
      total: 100,
      items: [{ name: 'パン', amount: 100, categoryId: 'food' }],
      status: 'matched',
      ...extra,
    },
    owner,
  });

  it('新しい順に並べ、OCR は写真のあるものだけを切り出す', () => {
    const samples = [
      receipt('a', '2026-09-01', { imageKey: 'k-a' }),
      receipt('b', '2026-10-01'),
      receipt('c', '2026-10-05', { imageKeys: ['k-c1', 'k-c2'] }),
    ];
    expect(selectSamples(samples, { task: 'ocr', offset: 0, limit: 10 }).map((s) => s.receipt.id)).toEqual(['c', 'a']);
    expect(selectSamples(samples, { task: 'classify', offset: 1, limit: 1 }).map((s) => s.receipt.id)).toEqual(['b']);
  });

  it('判定は値引きとカテゴリの無い品目しかないレシートを外す', () => {
    const samples = [receipt('a', '2026-10-01', { items: [{ name: '値引', amount: -50, categoryId: 'discount' }, { name: '?', amount: 10 }] })];
    expect(selectSamples(samples, { task: 'classify', offset: 0, limit: 10 })).toEqual([]);
  });
});

describe('overBudget', () => {
  it('Claude の組は使った額が予算に届いたら止める', () => {
    expect(overBudget({ model: 'claude-opus-5-5', maxUsd: 1 }, 0.99)).toBe(false);
    expect(overBudget({ model: 'claude-opus-5-5', maxUsd: 1 }, 1)).toBe(true);
  });

  it('費用を数えない jev と keywords は、予算が 0 でも止めない', () => {
    expect(overBudget({ model: 'jev', maxUsd: 0 }, 0)).toBe(false);
    expect(overBudget({ model: 'keywords', maxUsd: 0 }, 0)).toBe(false);
  });
});

describe('isSpendLimit', () => {
  it('残高切れとワークスペースの利用上限で止める', () => {
    expect(isSpendLimit('BadRequestError(400): Your credit balance is too low to access the Anthropic API.')).toBe(true);
    expect(isSpendLimit('RateLimitError(429): You have reached your specified workspace API usage limits.')).toBe(true);
    expect(isSpendLimit('RateLimitError(429): Number of request tokens has exceeded your per-minute rate limit')).toBe(false);
  });
});

describe('summarize', () => {
  it('費用は失敗した呼び出しの分も数え、率は測れたものだけで割る', () => {
    const ocrScore = {
      total: true,
      date: false,
      store: true,
      currency: true,
      truthItems: 2,
      draftItems: 2,
      exactItems: 2,
      amountItems: 2,
      itemF1: 1,
      amountF1: 1,
      balanced: true,
      warnings: 1,
    };
    const summary = summarize([
      { receiptId: 'a', status: 'ok', ms: 1000, usd: 0.05, ocr: ocrScore },
      { receiptId: 'b', status: 'ok', ms: 3000, usd: 0.05, ocr: { ...ocrScore, total: false } },
      { receiptId: 'c', status: 'error', error: 'x', usd: 0.02 },
      { receiptId: 'd', status: 'skipped', reason: 'image_expired' },
    ]);
    expect(summary).toMatchObject({ ok: 2, errors: 1, skipped: 1, usd: 0.12, msMean: 2000, ocr: { total: 0.5, date: 0, itemF1Mean: 1 } });
  });
});
