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

const PAYMENT = {
  id: 'r1',
  label: 'Netflix',
  amount: 1590,
  categoryId: 'subscription',
  dayOfMonth: 5,
  startMonth: '2026-01',
};

beforeAll(async () => {
  process.env.TABLE_NAME = 'test-table';
  process.env.RECEIPT_BUCKET = 'test-bucket';
  handler = (await import('../index')).handler;
});

beforeEach(() => {
  sent.length = 0;
  queryItems = [];
});

describe('PUT /recurring', () => {
  it('定期支払いの一覧を CONFIG#recurring に丸ごと保存する', async () => {
    const response = await handler(event('PUT', '/recurring', { recurring: [PAYMENT] }));
    expect(response).toMatchObject({ statusCode: 204 });

    const put = sent.find((command) => command.kind === 'put');
    expect(put?.input.Item).toMatchObject({ pk: 'USER#user-1', sk: 'CONFIG#recurring', recurring: [PAYMENT] });
  });

  it('配列でなければ 400 で断る', async () => {
    const response = await handler(event('PUT', '/recurring', { recurring: 'Netflix' }));
    expect(response).toMatchObject({ statusCode: 400 });
    expect(sent.filter((command) => command.kind === 'put')).toHaveLength(0);
  });
});

describe('GET /snapshot', () => {
  it('定期支払いも一緒に返す', async () => {
    queryItems = [
      { pk: 'USER#user-1', sk: 'CONFIG#recurring', recurring: [PAYMENT] },
      { pk: 'USER#user-1', sk: 'CONFIG#categories', categories: [{ id: 'food', label: '食費', order: 1 }] },
    ];

    const response = await handler(event('GET', '/snapshot'));
    const body = JSON.parse((response as { body: string }).body);
    expect(body.recurring).toEqual([PAYMENT]);
    expect(body.categories).toHaveLength(1);
  });

  it('まだ登録が無ければ空の配列を返す', async () => {
    const response = await handler(event('GET', '/snapshot'));
    const body = JSON.parse((response as { body: string }).body);
    expect(body.recurring).toEqual([]);
  });
});
