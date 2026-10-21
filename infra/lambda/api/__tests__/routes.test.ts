import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { matchRoute, type Route } from '../routes';

describe('matchRoute', () => {
  const routes: Route<string>[] = [
    { method: 'PUT', path: '/transactions', handle: 'bulk' },
    { method: 'PUT', path: '/transactions/:id', handle: 'one' },
    { method: 'POST', path: '/receipts/analyze', handle: 'analyze' },
    { method: 'PUT', path: '/receipts/:id', handle: 'receipt' },
  ];

  it('メソッドと区切りの数が合うものを選び、: の部分を取り出す', () => {
    expect(matchRoute(routes, 'PUT', ['transactions'])?.route.handle).toBe('bulk');
    expect(matchRoute(routes, 'PUT', ['transactions', 't1'])).toMatchObject({ route: { handle: 'one' }, params: { id: 't1' } });
  });

  it('表の上にあるものを先に見る', () => {
    expect(matchRoute(routes, 'POST', ['receipts', 'analyze'])?.route.handle).toBe('analyze');
    expect(matchRoute(routes, 'PUT', ['receipts', 'analyze'])?.params).toEqual({ id: 'analyze' });
  });

  it('メソッドか区切りの数が合わなければ選ばない', () => {
    expect(matchRoute(routes, 'GET', ['transactions'])).toBeUndefined();
    expect(matchRoute(routes, 'PUT', ['transactions', 't1', 'extra'])).toBeUndefined();
    expect(matchRoute(routes, 'PUT', [])).toBeUndefined();
  });
});

/*
 * ここから下は、これまでテストの無かったルートを handler から通す。
 * 保存先のキー（pk は sub から、sk は種類ごとの並び）と、応答の状態を見る。
 */

type Sent = { kind: string; input: Record<string, unknown> };
const sent: Sent[] = [];
let stored: Record<string, unknown> | undefined;

vi.mock('@aws-sdk/lib-dynamodb', () => {
  class Command {
    constructor(
      readonly kind: string,
      readonly input: Record<string, unknown>,
    ) {}
  }
  const command = (kind: string) =>
    class extends Command {
      constructor(input: Record<string, unknown>) {
        super(kind, input);
      }
    };
  return {
    DynamoDBDocumentClient: {
      from: () => ({
        async send(sentCommand: Command) {
          sent.push({ kind: sentCommand.kind, input: sentCommand.input });
          return sentCommand.kind === 'get' ? { Item: stored } : {};
        },
      }),
    },
    PutCommand: command('put'),
    GetCommand: command('get'),
    DeleteCommand: command('delete'),
    QueryCommand: command('query'),
    BatchWriteCommand: command('batchWrite'),
  };
});

let handler: typeof import('../index')['handler'];

function event(method: string, path: string, body?: unknown): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    rawPath: path,
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: { http: { method }, authorizer: { jwt: { claims: { sub: 'user-1' } } } },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

const RECEIPT = {
  id: 'r1',
  storeName: 'ローソン',
  date: '2026-09-01',
  total: 300,
  items: [{ name: 'おにぎり', amount: 150, categoryId: 'food' }, { name: 'お茶', amount: 150 }],
  status: 'pending',
  imageKey: 'receipts/user-1/2026-09-01/a.jpg',
};

const MAPPING = {
  sourceId: 'credit',
  label: '楽天カード',
  source: 'credit',
  mapping: { headerRowIndex: 0, date: 0, merchant: 1, amount: 2, sign: 'positive-expense' },
};

const last = (kind: string) => sent.filter((command) => command.kind === kind).at(-1)?.input;

beforeAll(async () => {
  process.env.TABLE_NAME = 'test-table';
  process.env.RECEIPT_BUCKET = 'test-bucket';
  process.env.OCR_FUNCTION_NAME = 'test-ocr';
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  handler = (await import('../index')).handler;
});

beforeEach(() => {
  sent.length = 0;
  stored = undefined;
});

describe('api のルート', () => {
  it('sub が無ければ 401', async () => {
    const response = await handler({ ...event('GET', '/snapshot'), requestContext: { http: { method: 'GET' } } } as never);
    expect(response).toMatchObject({ statusCode: 401 });
  });

  it('カテゴリとルールは 1 行にまとめて保存する', async () => {
    expect(await handler(event('PUT', '/categories', { categories: [{ id: 'food' }] }))).toMatchObject({ statusCode: 204 });
    expect(last('put')?.Item).toMatchObject({ pk: 'USER#user-1', sk: 'CONFIG#categories', categories: [{ id: 'food' }] });

    expect(await handler(event('PUT', '/rules', { rules: [] }))).toMatchObject({ statusCode: 204 });
    expect(last('put')?.Item).toMatchObject({ sk: 'CONFIG#rules', rules: [] });
  });

  it('一覧が無ければ 400', async () => {
    expect(await handler(event('PUT', '/categories', {}))).toMatchObject({ statusCode: 400 });
    expect(sent).toEqual([]);
  });

  it('上限は月ごとに保存し、月の形が違えば 400', async () => {
    expect(await handler(event('PUT', '/budgets/2026-09', { limits: { food: 30000 } }))).toMatchObject({ statusCode: 204 });
    expect(last('put')?.Item).toMatchObject({ sk: 'BUDGET#2026-09', month: '2026-09', limits: { food: 30000 } });

    expect(await handler(event('PUT', '/budgets/2026-9', { limits: {} }))).toMatchObject({ statusCode: 400 });
    expect(await handler(event('PUT', '/budgets/2026-09', {}))).toMatchObject({ statusCode: 400 });
  });

  it('列の対応は取り込み元ごとに保存し、形が違えば 400', async () => {
    expect(await handler(event('PUT', '/mappings/credit', MAPPING))).toMatchObject({ statusCode: 204 });
    expect(last('put')?.Item).toMatchObject({ pk: 'USER#user-1', sk: 'MAPPING#credit', sourceId: 'credit' });

    expect(await handler(event('PUT', '/mappings/credit', { sourceId: 'credit' }))).toMatchObject({ statusCode: 400 });
  });

  it('レシートはパスの id で保存し、消す', async () => {
    expect(await handler(event('PUT', '/receipts/r1', { ...RECEIPT, id: 'other' }))).toMatchObject({ statusCode: 204 });
    expect(last('put')?.Item).toMatchObject({ pk: 'USER#user-1', sk: 'RECEIPT#r1', id: 'r1', storeName: 'ローソン' });

    expect(await handler(event('DELETE', '/receipts/r1'))).toMatchObject({ statusCode: 204 });
    expect(last('delete')?.Key).toEqual({ pk: 'USER#user-1', sk: 'RECEIPT#r1' });
  });

  it('レシートの形が違えば 400 で、保存しない', async () => {
    expect(await handler(event('PUT', '/receipts/r1', { id: 'r1', storeName: 'ローソン' }))).toMatchObject({ statusCode: 400 });
    expect(await handler(event('PUT', '/receipts/r1', { ...RECEIPT, imageKey: 'receipts/someone-else/a.jpg' }))).toMatchObject({
      statusCode: 400,
    });
    expect(sent.filter((command) => command.kind === 'put')).toEqual([]);
  });

  it('壊れた JSON の本文は 400', async () => {
    const broken = { ...event('PUT', '/receipts/r1'), body: '{"storeName": ' } as APIGatewayProxyEventV2WithJWTAuthorizer;
    expect(await handler(broken)).toMatchObject({ statusCode: 400 });
  });

  it('明細を消す', async () => {
    expect(await handler(event('DELETE', '/transactions/t1'))).toMatchObject({ statusCode: 204 });
    expect(last('delete')?.Key).toEqual({ pk: 'USER#user-1', sk: 'TXN#t1' });
  });

  it('レポートは作ってあれば返し、無ければ 404', async () => {
    expect(await handler(event('GET', '/reports/2026-09'))).toMatchObject({ statusCode: 404 });
    expect(last('get')?.Key).toEqual({ pk: 'USER#user-1', sk: 'REPORT#2026-09' });

    stored = { report: { month: '2026-09' } };
    const found = await handler(event('GET', '/reports/2026-09'));
    expect(found).toMatchObject({ statusCode: 200 });
    expect(JSON.parse((found as { body: string }).body)).toEqual({ month: '2026-09' });
  });

  it('表に無い操作は 404', async () => {
    expect(await handler(event('GET', '/nothing'))).toMatchObject({ statusCode: 404 });
    expect(await handler(event('PATCH', '/transactions/t1'))).toMatchObject({ statusCode: 404 });
    expect(sent).toEqual([]);
  });
});
