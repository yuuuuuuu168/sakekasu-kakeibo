import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Receipt } from '@kakeibo/core';

type Sent = { kind: string; input: Record<string, unknown> };
const state = vi.hoisted(() => ({
  sent: [] as Sent[],
  fail: undefined as (() => Error) | undefined,
  items: {} as Record<string, Record<string, unknown>>,
}));

vi.mock('@aws-sdk/lib-dynamodb', () => {
  const command = (kind: string) =>
    class {
      kind = kind;
      constructor(readonly input: Record<string, unknown>) {}
    };
  return {
    DynamoDBDocumentClient: {
      from: () => ({
        async send(sent: { kind: string; input: Record<string, unknown> }) {
          state.sent.push({ kind: sent.kind, input: sent.input });
          if (state.fail && (sent.kind === 'update' || sent.kind === 'transact')) throw state.fail();
          if (sent.kind === 'get') return { Item: state.items[(sent.input.Key as { sk: string }).sk] };
          return {};
        },
      }),
    },
    GetCommand: command('get'),
    QueryCommand: command('query'),
    UpdateCommand: command('update'),
    TransactWriteCommand: command('transact'),
  };
});

let store: typeof import('../store');
let dynamodb: typeof import('@aws-sdk/client-dynamodb');

beforeAll(async () => {
  process.env.TABLE_NAME = 'table';
  store = await import('../store');
  dynamodb = await import('@aws-sdk/client-dynamodb');
});

beforeEach(() => {
  state.sent = [];
  state.fail = undefined;
  state.items = {};
});

const receipt: Receipt = {
  id: 'r-1',
  storeName: 'Amazon',
  date: '2026-11-22',
  total: 1398,
  items: [],
  status: 'pending',
  orderNumber: '250-1',
  messageId: '<m@x>',
  source: 'mail',
};

describe('countCall', () => {
  it('日本時間の日付の行を、上限の条件つきで 1 つ数える', async () => {
    expect(await store.countCall('sub-1', new Date('2026-11-22T16:00:00Z'))).toBe(true);
    const { input } = state.sent[0];
    expect(input.Key).toEqual({ pk: 'MAILINBOX#sub-1', sk: 'DAY#2026-11-23' });
    expect(input.ConditionExpression).toBe('attribute_not_exists(calls) OR calls < :limit');
    expect((input.ExpressionAttributeValues as Record<string, unknown>)[':limit']).toBe(store.MAIL_DAILY_LIMIT);
  });

  it('上限に届いていたら false', async () => {
    state.fail = () => new dynamodb.ConditionalCheckFailedException({ message: 'no', $metadata: {} });
    expect(await store.countCall('sub-1', new Date())).toBe(false);
  });
});

describe('createReceipt', () => {
  it('レシートは利用者のパーティション、印は別のパーティションに、無ければ書く条件で入れる', async () => {
    expect(await store.createReceipt('sub-1', receipt)).toEqual({ created: true });
    const items = (state.sent[0].input.TransactItems as { Put: { Item: Record<string, unknown>; ConditionExpression: string } }[]).map(
      (entry) => entry.Put,
    );
    expect(items.map((put) => [put.Item.pk, put.Item.sk])).toEqual([
      ['USER#sub-1', 'RECEIPT#r-1'],
      ['MAILINBOX#sub-1', store.markerSk.order('250-1')],
      ['MAILINBOX#sub-1', store.markerSk.message('<m@x>')],
    ]);
    expect(items.every((put) => put.ConditionExpression === 'attribute_not_exists(pk)')).toBe(true);
  });

  it('印がもうあれば、先に置かれた下書きの id を返す', async () => {
    state.fail = () =>
      new dynamodb.TransactionCanceledException({
        message: 'cancelled',
        $metadata: {},
        CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
      });
    state.items[store.markerSk.order('250-1')] = { receiptId: 'r-first' };
    expect(await store.createReceipt('sub-1', receipt)).toEqual({ created: false, existingId: 'r-first' });
  });
});

it('印の sk は注文番号・Message-ID の長さに関わらず揃う', () => {
  expect(store.markerSk.message('<'.repeat(2000))).toMatch(/^MESSAGE#[0-9a-f]{64}$/);
});
