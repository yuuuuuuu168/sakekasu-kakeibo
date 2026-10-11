import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Sent = { kind: string; input: Record<string, unknown> };

const sent: Sent[] = [];
let imageBytes: Uint8Array;
let modelText: string;
let modelError: Error | undefined;

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: () => ({
      async send(command: { input: Record<string, unknown> }) {
        sent.push({ kind: 'update', input: command.input });
        return {};
      },
    }),
  },
  UpdateCommand: class {
    constructor(readonly input: Record<string, unknown>) {}
  },
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    async send(command: { input: Record<string, unknown> }) {
      sent.push({ kind: 's3', input: command.input });
      return { Body: { transformToByteArray: async () => imageBytes } };
    }
  },
  GetObjectCommand: class {
    constructor(readonly input: Record<string, unknown>) {}
  },
}));

vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: class {
    async send() {
      if (modelError) throw modelError;
      return { body: new TextEncoder().encode(JSON.stringify({ content: [{ text: modelText }] })) };
    }
  },
  InvokeModelCommand: class {
    constructor(readonly input: Record<string, unknown>) {}
  },
}));

let handler: typeof import('../index')['handler'];

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const JOB = { jobId: 'job-1', sub: 'user-1', key: 'receipts/user-1/2026-10-11/a.jpg' };

function updates(): Record<string, unknown>[] {
  return sent.filter((call) => call.kind === 'update').map((call) => call.input);
}

beforeAll(async () => {
  process.env.RECEIPT_BUCKET = 'test-bucket';
  process.env.BEDROCK_MODEL_ID = 'test-model';
  process.env.TABLE_NAME = 'test-table';
  handler = (await import('../index')).handler;
});

beforeEach(() => {
  sent.length = 0;
  imageBytes = JPEG;
  modelText = '{"storeName":"ローソン","date":"2026-10-10","total":540,"items":[{"name":"おにぎり","amount":540}]}';
  modelError = undefined;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('OCR の関数（ジョブを受けて結果を書く）', () => {
  it('読み取れたら done と下書きを、api が作ったジョブの行にだけ書く', async () => {
    await handler(JOB);

    const [update] = updates();
    expect(update).toMatchObject({
      TableName: 'test-table',
      Key: { pk: 'OCR#user-1', sk: 'JOB#job-1' },
      ConditionExpression: 'attribute_exists(pk)',
    });
    const values = update.ExpressionAttributeValues as Record<string, unknown>;
    expect(values[':status']).toBe('done');
    expect(values[':draft']).toMatchObject({ storeName: 'ローソン', total: 540 });
  });

  it('モデルが失敗しても投げずに failed と理由を書く（非同期の再試行で読み直させない）', async () => {
    modelError = new Error('ThrottlingException');
    await expect(handler(JOB)).resolves.toBeUndefined();

    const values = updates()[0].ExpressionAttributeValues as Record<string, unknown>;
    expect(values[':status']).toBe('failed');
    expect(values[':message']).toBe('ThrottlingException');
  });

  it('画像でないものは failed にする', async () => {
    imageBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0, 0, 0, 0, 0, 0, 0, 0]);
    await handler(JOB);
    const values = updates()[0].ExpressionAttributeValues as Record<string, unknown>;
    expect(values[':status']).toBe('failed');
  });

  it('他人の画像のキーは読まずに failed にする', async () => {
    await handler({ ...JOB, key: 'receipts/someone-else/a.jpg' });
    expect(sent.some((call) => call.kind === 's3')).toBe(false);
    const values = updates()[0].ExpressionAttributeValues as Record<string, unknown>;
    expect(values[':status']).toBe('failed');
  });

  it('本文が足りなければ何も書かない', async () => {
    await handler({ jobId: 'job-1' });
    expect(sent).toEqual([]);
  });
});
