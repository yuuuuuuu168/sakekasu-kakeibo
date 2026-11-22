import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { Receipt } from '@kakeibo/core';
import { hashToken, type InboxKey } from '../token';

const token = 'kkb_handler-test-token-0123456789';
const key: InboxKey = { id: 'muse-1', tokenHash: hashToken(token), sub: 'sub-1', expiresAt: '2099-01-01T00:00:00Z' };

const state = vi.hoisted(() => ({
  secret: '' as string | undefined,
  allowCall: true,
  receipts: [] as Receipt[],
  marked: undefined as string | undefined,
  created: [] as Receipt[],
  race: undefined as string | undefined,
}));

vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class {
    async send() {
      return { SecretString: state.secret };
    }
  },
  GetSecretValueCommand: class {},
}));

vi.mock('../store', () => ({
  countCall: async () => state.allowCall,
  loadContext: async () => ({ receipts: state.receipts, categories: [], rules: [] }),
  findMarkedReceiptId: async () => state.marked,
  createReceipt: async (_sub: string, receipt: Receipt) => {
    if (state.race) return { created: false, existingId: state.race };
    state.created.push(receipt);
    return { created: true };
  },
}));

vi.mock('../judge', () => ({ judgeItems: async (items: unknown) => items }));

let handler: (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyStructuredResultV2>;

beforeAll(async () => {
  process.env.MAIL_INBOX_SECRET_ID = 'arn:test';
  ({ handler } = (await import('../index')) as unknown as { handler: typeof handler });
});

beforeEach(() => {
  state.secret = JSON.stringify({ keys: [key] });
  state.allowCall = true;
  state.receipts = [];
  state.marked = undefined;
  state.created = [];
  state.race = undefined;
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

const draft = {
  date: '2026-11-22',
  store: 'Amazon',
  title: 'モノンズのアイマスク',
  amount: 1398,
  order_number: '250-4917807-1616660',
  source: 'mail',
  message_id: '<abc@mail.example>',
};

function event(body: unknown, overrides: { token?: string | null } = {}): APIGatewayProxyEventV2 {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const presented = overrides.token === undefined ? token : overrides.token;
  return {
    body: text,
    isBase64Encoded: false,
    headers: {
      'content-type': 'application/json',
      // API Gateway（HTTP API）はヘッダの名前を小文字にして渡す
      ...(presented === null ? {} : { authorization: `Bearer ${presented}` }),
    },
  } as unknown as APIGatewayProxyEventV2;
}

const bodyOf = (result: APIGatewayProxyStructuredResultV2) => JSON.parse(result.body ?? '{}');

describe('POST /draft-entries', () => {
  it('新しい注文は 201 で文字列の id と draft を返し、メールのレシートとして置く', async () => {
    const result = await handler(event(draft));
    expect(result.statusCode).toBe(201);
    expect(bodyOf(result)).toEqual({ id: expect.stringMatching(/^r-/), status: 'draft' });
    expect(state.created[0]).toMatchObject({ id: bodyOf(result).id, source: 'mail', status: 'pending', total: 1398 });
  });

  it('同じ注文番号のレシートがあれば作らずに 200 で既存の id を返す', async () => {
    state.receipts = [{ id: 'r-old', storeName: 'Amazon', date: '2026-11-22', total: 1398, items: [], status: 'matched', orderNumber: draft.order_number }];
    const result = await handler(event(draft));
    expect(result.statusCode).toBe(200);
    expect(bodyOf(result)).toEqual({ id: 'r-old', status: 'draft' });
    expect(state.created).toHaveLength(0);
  });

  it('レシートが消えていても、重複の印が残っていれば既存として返す', async () => {
    state.marked = 'r-gone';
    expect(bodyOf(await handler(event(draft)))).toEqual({ id: 'r-gone', status: 'draft' });
  });

  it('同じ注文の別のメールが先に通ったら、そちらの id を 200 で返す', async () => {
    state.race = 'r-first';
    const result = await handler(event(draft));
    expect(result.statusCode).toBe(200);
    expect(bodyOf(result).id).toBe('r-first');
  });

  it('トークンが違えば 401 で、理由は返さない', async () => {
    const result = await handler(event(draft, { token: 'kkb_wrong' }));
    expect(result.statusCode).toBe(401);
    expect(bodyOf(result)).toEqual({ error: 'unauthorized', message: '認証に失敗しました' });
    expect(console.warn).toHaveBeenCalledWith('[mail-inbox] auth-failed');
  });

  it('失効した鍵（一覧から消した鍵）は 401', async () => {
    state.secret = JSON.stringify({ keys: [] });
    expect((await handler(event(draft))).statusCode).toBe(401);
  });

  it('Authorization ヘッダが無ければ 401', async () => {
    expect((await handler(event(draft, { token: null }))).statusCode).toBe(401);
  });

  it('認証に失敗したら本文が壊れていても 401 で、検査には進まない', async () => {
    expect((await handler(event('not json', { token: 'kkb_wrong' }))).statusCode).toBe(401);
  });

  it('1 日の上限を超えたら 429', async () => {
    state.allowCall = false;
    const result = await handler(event(draft));
    expect(result.statusCode).toBe(429);
    expect(bodyOf(result).error).toBe('rate_limited');
    expect(state.created).toHaveLength(0);
  });

  it('検証エラーは 422 で項目と理由を並べ、何も作らない', async () => {
    const result = await handler(event({ ...draft, amount: 30_001 }));
    expect(result.statusCode).toBe(422);
    expect(bodyOf(result)).toEqual({
      error: 'validation_error',
      details: [{ field: 'amount', message: '1以上30000以下の整数で入力してください' }],
    });
    expect(state.created).toHaveLength(0);
  });

  it('JSON でない本文は 422', async () => {
    expect((await handler(event('not json'))).statusCode).toBe(422);
  });

  it('期限が 14 日を切った鍵は通しつつ警告の行を出す', async () => {
    state.secret = JSON.stringify({ keys: [{ ...key, expiresAt: new Date(Date.now() + 3 * 86_400_000).toISOString() }] });
    expect((await handler(event(draft))).statusCode).toBe(201);
    expect(console.warn).toHaveBeenCalledWith('[mail-inbox] key-expiring', expect.stringContaining('muse-1'));
  });

  it('ログの 1 行に結果・id・鍵の名前・店名・品目名・金額を出し、トークンは出さない', async () => {
    await handler(event(draft));
    const line = vi.mocked(console.info).mock.calls.find((call) => call[0] === '[mail-inbox]')?.[1] as string;
    const logged = JSON.parse(line);
    expect(logged).toMatchObject({ 結果: '作成', 状態: 201, 鍵: 'muse-1', 店: 'Amazon', 金額: 1398, 品目: ['モノンズのアイマスク 1398'] });
    expect(logged.id).toMatch(/^r-/);
    expect(line).not.toContain(token);
  });

  it('認証に失敗したときも、送られたトークンをログに出さない', async () => {
    await handler(event(draft, { token: 'kkb_leaked-guess-value' }));
    const all = [...vi.mocked(console.info).mock.calls, ...vi.mocked(console.warn).mock.calls].flat().join('\n');
    expect(all).not.toContain('kkb_leaked-guess-value');
  });
});
