import { beforeAll, describe, expect, it } from 'vitest';

/** モジュールの読み込み時に環境変数を見るので、先に置いてから動的に読み込む */
let sniffMediaType: typeof import('../index')['sniffMediaType'];

beforeAll(async () => {
  process.env.RECEIPT_BUCKET = 'test-bucket';
  process.env.BEDROCK_MODEL_ID = 'test-model';
  process.env.TABLE_NAME = 'test-table';
  sniffMediaType = (await import('../index')).sniffMediaType;
});

describe('sniffMediaType', () => {
  it('中身のバイト列から形式を決める', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]);
    const text = new Uint8Array(Buffer.from('not an image at all'));
    expect(sniffMediaType(jpeg)).toBe('image/jpeg');
    expect(sniffMediaType(png)).toBe('image/png');
    expect(sniffMediaType(text)).toBeUndefined();
    expect(sniffMediaType(new Uint8Array([0xff]))).toBeUndefined();
  });
});
