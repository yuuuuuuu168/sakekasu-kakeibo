import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { OCR_JOB_STALE_MS } from '../../shared/ocr-job';

type Sent = { kind: string; input: Record<string, unknown> };

const sent: Sent[] = [];
let storedJob: Record<string, unknown> | undefined;

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
          return sentCommand.kind === 'get' ? { Item: storedJob } : {};
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

vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class {
    async send(command: { input: Record<string, unknown> }) {
      sent.push({ kind: 'invoke', input: command.input });
      return {};
    }
  },
  InvokeCommand: class {
    constructor(readonly input: Record<string, unknown>) {}
  },
}));

let handler: typeof import('../index')['handler'];

function event(method: string, path: string, body?: unknown): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    rawPath: path,
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: { http: { method }, authorizer: { jwt: { claims: { sub: 'user-1' } } } },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

function bodyOf(response: unknown): Record<string, unknown> {
  return JSON.parse((response as { body: string }).body) as Record<string, unknown>;
}

beforeAll(async () => {
  process.env.TABLE_NAME = 'test-table';
  process.env.RECEIPT_BUCKET = 'test-bucket';
  process.env.OCR_FUNCTION_NAME = 'test-ocr';
  handler = (await import('../index')).handler;
});

beforeEach(() => {
  sent.length = 0;
  storedJob = undefined;
});

describe('POST /receipts/analyze（読み取りの受け付け）', () => {
  it('ジョブの行を作り、OCR の関数を非同期で呼んで jobId を返す', async () => {
    const response = await handler(event('POST', '/receipts/analyze', { key: 'receipts/user-1/2026-10-11/a.jpg' }));
    expect(response).toMatchObject({ statusCode: 202 });
    const { jobId } = bodyOf(response);
    expect(typeof jobId).toBe('string');

    const put = sent.find((call) => call.kind === 'put');
    expect(put?.input.Item).toMatchObject({
      pk: 'OCR#user-1',
      sk: `JOB#${jobId}`,
      status: 'pending',
      key: 'receipts/user-1/2026-10-11/a.jpg',
    });
    expect(typeof (put?.input.Item as Record<string, unknown>).expiresAt).toBe('number');

    const invoke = sent.find((call) => call.kind === 'invoke');
    expect(invoke?.input).toMatchObject({ FunctionName: 'test-ocr', InvocationType: 'Event' });
    expect(JSON.parse(Buffer.from(invoke!.input.Payload as Uint8Array).toString())).toEqual({
      jobId,
      sub: 'user-1',
      key: 'receipts/user-1/2026-10-11/a.jpg',
    });
  });

  it('他人の画像のキーは受け付けず、OCR も呼ばない', async () => {
    const response = await handler(event('POST', '/receipts/analyze', { key: 'receipts/someone-else/a.jpg' }));
    expect(response).toMatchObject({ statusCode: 403 });
    expect(sent).toEqual([]);
  });

  it('キーが無ければ 400', async () => {
    const response = await handler(event('POST', '/receipts/analyze', {}));
    expect(response).toMatchObject({ statusCode: 400 });
    expect(sent).toEqual([]);
  });
});

describe('GET /receipts/analyze/{jobId}（読み取りの結果）', () => {
  it('自分のパーティションからだけ読む', async () => {
    await handler(event('GET', '/receipts/analyze/job-1'));
    expect(sent).toEqual([{ kind: 'get', input: { TableName: 'test-table', Key: { pk: 'OCR#user-1', sk: 'JOB#job-1' } } }]);
  });

  it('done は下書きを返す', async () => {
    storedJob = { status: 'done', draft: { storeName: 'ローソン' }, createdAt: new Date().toISOString() };
    const response = await handler(event('GET', '/receipts/analyze/job-1'));
    expect(bodyOf(response)).toEqual({ status: 'done', draft: { storeName: 'ローソン' } });
  });

  it('failed は理由を返す', async () => {
    storedJob = { status: 'failed', message: '画像が大きすぎます', createdAt: new Date().toISOString() };
    const response = await handler(event('GET', '/receipts/analyze/job-1'));
    expect(bodyOf(response)).toEqual({ status: 'failed', message: '画像が大きすぎます' });
  });

  it('pending はそのまま返す', async () => {
    storedJob = { status: 'pending', createdAt: new Date().toISOString() };
    const response = await handler(event('GET', '/receipts/analyze/job-1'));
    expect(bodyOf(response)).toEqual({ status: 'pending' });
  });

  it('読み取りの Lambda のタイムアウトを過ぎても pending なら failed で返す', async () => {
    storedJob = { status: 'pending', createdAt: new Date(Date.now() - OCR_JOB_STALE_MS - 1000).toISOString() };
    const response = await handler(event('GET', '/receipts/analyze/job-1'));
    expect(bodyOf(response)).toMatchObject({ status: 'failed' });
  });

  it('見つからなければ 404', async () => {
    const response = await handler(event('GET', '/receipts/analyze/job-1'));
    expect(response).toMatchObject({ statusCode: 404 });
  });
});
