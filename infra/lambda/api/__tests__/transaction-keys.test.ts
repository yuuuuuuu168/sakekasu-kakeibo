import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';

type Sent = { kind: string; input: Record<string, unknown> };

const sent: Sent[] = [];
let queryItems: Record<string, unknown>[] = [];

vi.mock('@aws-sdk/lib-dynamodb', () => {
  class Command {
    constructor(
      readonly kind: string,
      readonly input: Record<string, unknown>,
    ) {}
  }
  return {
    DynamoDBDocumentClient: {
      from: () => ({
        async send(command: Command) {
          sent.push({ kind: command.kind, input: command.input });
          return command.kind === 'query' ? { Items: queryItems } : {};
        },
      }),
    },
    PutCommand: class extends Command {
      constructor(input: Record<string, unknown>) {
        super('put', input);
      }
    },
    GetCommand: class extends Command {
      constructor(input: Record<string, unknown>) {
        super('get', input);
      }
    },
    DeleteCommand: class extends Command {
      constructor(input: Record<string, unknown>) {
        super('delete', input);
      }
    },
    QueryCommand: class extends Command {
      constructor(input: Record<string, unknown>) {
        super('query', input);
      }
    },
    BatchWriteCommand: class extends Command {
      constructor(input: Record<string, unknown>) {
        super('batchWrite', input);
      }
    },
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

// 本文に他人のパーティションや設定のキーを混ぜても、保存先は sub から組み立てた値になること。
// 一括取り込みはキーを展開の前に置いていたため、本文の pk / sk が勝っていた
const HOSTILE = {
  pk: 'USER#someone-else',
  sk: 'CONFIG#categories',
  id: 't1',
  date: '2026-09-01',
  amount: 1000,
  splits: [{ id: 's1', amount: 1000, categoryId: 'food' }],
};

beforeAll(async () => {
  process.env.TABLE_NAME = 'test-table';
  process.env.RECEIPT_BUCKET = 'test-bucket';
  process.env.OCR_FUNCTION_NAME = 'test-ocr';
  handler = (await import('../index')).handler;
});

beforeEach(() => {
  sent.length = 0;
  queryItems = [];
});

describe('明細の保存先のキー', () => {
  it('一括取り込みは本文の pk / sk を無視する', async () => {
    const response = await handler(event('PUT', '/transactions', { transactions: [HOSTILE] }));
    expect(response).toMatchObject({ statusCode: 204 });

    const writes = sent.filter((command) => command.kind === 'batchWrite');
    expect(writes).toHaveLength(1);
    const items = (writes[0].input.RequestItems as Record<string, { PutRequest: { Item: Record<string, unknown> } }[]>)[
      'test-table'
    ];
    expect(items).toHaveLength(1);
    expect(items[0].PutRequest.Item.pk).toBe('USER#user-1');
    expect(items[0].PutRequest.Item.sk).toBe('TXN#t1');
  });

  it('1 件ずつの保存も本文の pk / sk を無視する', async () => {
    const response = await handler(event('PUT', '/transactions/t1', HOSTILE));
    expect(response).toMatchObject({ statusCode: 204 });

    const puts = sent.filter((command) => command.kind === 'put');
    expect(puts).toHaveLength(1);
    const item = puts[0].input.Item as Record<string, unknown>;
    expect(item.pk).toBe('USER#user-1');
    expect(item.sk).toBe('TXN#t1');
  });
});
