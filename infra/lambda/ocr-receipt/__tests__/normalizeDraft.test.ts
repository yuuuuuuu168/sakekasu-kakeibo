import { beforeAll, describe, expect, it } from 'vitest';

/** モジュールの読み込み時に環境変数を見るので、先に置いてから動的に読み込む */
let normalizeDraft: typeof import('../index')['normalizeDraft'];
let sniffMediaType: typeof import('../index')['sniffMediaType'];

const CATEGORIES = [
  { id: 'food', label: '食費' },
  { id: 'daily', label: '日用品' },
  { id: 'cafe', label: 'カフェ・嗜好品' },
];

beforeAll(async () => {
  process.env.RECEIPT_BUCKET = 'test-bucket';
  process.env.BEDROCK_MODEL_ID = 'test-model';
  const module = await import('../index');
  normalizeDraft = module.normalizeDraft;
  sniffMediaType = module.sniffMediaType;
});

describe('normalizeDraft', () => {
  it('前後に説明が付いていても JSON を取り出す', () => {
    const text = '```json\n{"storeName":"セブン-イレブン","date":"2026-09-01","total":1200,"items":[{"name":"おにぎり","amount":150,"categoryId":"food"}]}\n```';
    const draft = normalizeDraft(text, CATEGORIES);
    expect(draft.storeName).toBe('セブン-イレブン');
    expect(draft.date).toBe('2026-09-01');
    expect(draft.total).toBe(1200);
    expect(draft.items[0]).toMatchObject({ name: 'おにぎり', amount: 150, categoryId: 'food' });
  });

  it('金額が文字列で返ってきても円の整数に直す', () => {
    const draft = normalizeDraft(
      '{"storeName":"店","date":"2026-09-01","total":"1,200円","items":[{"name":"おにぎり","amount":"150"}]}',
      CATEGORIES,
    );
    expect(draft.total).toBe(1200);
    expect(draft.items[0].amount).toBe(150);
  });

  it('知らないカテゴリを返してきたら品目名から当て直す', () => {
    const draft = normalizeDraft(
      '{"storeName":"店","date":"2026-09-01","total":398,"items":[{"name":"ティッシュ 5箱","amount":398,"categoryId":"nonexistent"}]}',
      CATEGORIES,
    );
    expect(draft.items[0].categoryId).toBe('daily');
  });

  it('品目の合計が合計と離れていれば注意を残す', () => {
    const draft = normalizeDraft(
      '{"storeName":"店","date":"2026-09-01","total":5000,"items":[{"name":"おにぎり","amount":150}]}',
      CATEGORIES,
    );
    expect(draft.warnings.join('')).toContain('離れています');
  });

  it('品目や日付が読めなければ注意を残す', () => {
    const draft = normalizeDraft('{"storeName":"店","date":"","total":1200,"items":[]}', CATEGORIES);
    expect(draft.warnings.join('')).toContain('品目を読み取れませんでした');
    expect(draft.warnings.join('')).toContain('日付を読み取れませんでした');
  });

  it('JSON が壊れていても落ちずに手入力を促す', () => {
    const draft = normalizeDraft('読み取れませんでした', CATEGORIES);
    expect(draft.items).toHaveLength(0);
    expect(draft.warnings[0]).toContain('手で入れて');
  });

  it('合計が無ければ品目の合計で埋める', () => {
    const draft = normalizeDraft(
      '{"storeName":"店","date":"2026-09-01","items":[{"name":"おにぎり","amount":150},{"name":"お茶","amount":130}]}',
      CATEGORIES,
    );
    expect(draft.total).toBe(280);
    expect(draft.warnings.join('')).toContain('合計を読み取れませんでした');
  });

  it('値引きの負の金額をそのまま持つ', () => {
    const draft = normalizeDraft(
      '{"storeName":"店","date":"2026-09-01","total":1150,"items":[{"name":"おにぎり","amount":1200},{"name":"クーポン値引","amount":-50}]}',
      CATEGORIES,
    );
    expect(draft.items[1].amount).toBe(-50);
  });
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
