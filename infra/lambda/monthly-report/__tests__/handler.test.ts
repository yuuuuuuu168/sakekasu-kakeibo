import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Sent = { kind: string; input: Record<string, unknown> };

const sent: Sent[] = [];
let scanned: Record<string, unknown>[] = [];

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
          return sentCommand.kind === 'scan' ? { Items: scanned } : { Items: [] };
        },
      }),
    },
    PutCommand: command('put'),
    QueryCommand: command('query'),
    ScanCommand: command('scan'),
  };
});

let handler: typeof import('../index').handler;

beforeAll(async () => {
  process.env.TABLE_NAME = 'test-table';
  ({ handler } = await import('../index'));
});

beforeEach(() => {
  sent.length = 0;
  scanned = [];
});

describe('monthly-report', () => {
  it('Scan を利用者のパーティションに絞る', async () => {
    await handler({ month: '2026-09' });

    const scan = sent.find((command) => command.kind === 'scan');
    expect(scan?.input).toMatchObject({
      FilterExpression: 'begins_with(pk, :user)',
      ExpressionAttributeValues: { ':user': 'USER#' },
    });
  });

  it('OCR のジョブのパーティションにはレポートを書かない', async () => {
    scanned = [{ pk: 'USER#user-1' }, { pk: 'USER#user-1' }, { pk: 'OCR#user-1' }];

    const result = await handler({ month: '2026-09' });

    expect(result).toEqual({ month: '2026-09', users: 1 });
    const puts = sent.filter((command) => command.kind === 'put');
    expect(puts.map((put) => (put.input.Item as Record<string, unknown>).pk)).toEqual(['USER#user-1']);
    expect((puts[0].input.Item as Record<string, unknown>).sk).toBe('REPORT#2026-09');
  });
});
