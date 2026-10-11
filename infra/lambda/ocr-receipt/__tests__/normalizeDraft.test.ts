import { beforeAll, describe, expect, it } from 'vitest';

/** モジュールの読み込み時に環境変数を見るので、先に置いてから動的に読み込む */
let normalizeDraft: typeof import('../index')['normalizeDraft'];
let sniffMediaType: typeof import('../index')['sniffMediaType'];

beforeAll(async () => {
  process.env.RECEIPT_BUCKET = 'test-bucket';
  process.env.BEDROCK_MODEL_ID = 'test-model';
  process.env.TABLE_NAME = 'test-table';
  const module = await import('../index');
  normalizeDraft = module.normalizeDraft;
  sniffMediaType = module.sniffMediaType;
});

describe('normalizeDraft', () => {
  it('前後に説明が付いていても JSON を取り出す', () => {
    const text = '```json\n{"storeName":"セブン-イレブン","date":"2026-09-01","total":1200,"items":[{"name":"おにぎり","amount":150}]}\n```';
    const draft = normalizeDraft(text);
    expect(draft.storeName).toBe('セブン-イレブン');
    expect(draft.date).toBe('2026-09-01');
    expect(draft.total).toBe(1200);
    expect(draft.items[0]).toMatchObject({ name: 'おにぎり', amount: 150, categoryId: 'food-deli' });
  });

  it('金額が文字列で返ってきても円の整数に直す', () => {
    const draft = normalizeDraft(
      '{"storeName":"店","date":"2026-09-01","total":"1,200円","items":[{"name":"おにぎり","amount":"150"}]}'
    );
    expect(draft.total).toBe(1200);
    expect(draft.items[0].amount).toBe(150);
  });

  /*
   * カテゴリはモデルに聞かない。ここで付くのはキーワード表の答えで、
   * 判定が届かなかったときに残る控え。本番の判定は画面が /classify に聞く。
   */
  it('品目名からキーワード表で仮のカテゴリを当てる', () => {
    const draft = normalizeDraft(
      '{"storeName":"店","date":"2026-09-01","total":398,"items":[{"name":"ティッシュ 5箱","amount":398}]}'
    );
    expect(draft.items[0].categoryId).toBe('daily-consumables');
  });

  it('カテゴリを返してきても読み捨てる', () => {
    const draft = normalizeDraft(
      '{"storeName":"店","date":"2026-09-01","total":398,"items":[{"name":"ティッシュ 5箱","amount":398,"categoryId":"food"}]}'
    );
    expect(draft.items[0].categoryId).toBe('daily-consumables');
  });

  it('品目の合計が合計と離れていれば注意を残す', () => {
    const draft = normalizeDraft(
      '{"storeName":"店","date":"2026-09-01","total":5000,"items":[{"name":"おにぎり","amount":150}]}'
    );
    expect(draft.warnings.join('')).toContain('離れています');
  });

  it('品目や日付が読めなければ注意を残す', () => {
    const draft = normalizeDraft('{"storeName":"店","date":"","total":1200,"items":[]}');
    expect(draft.warnings.join('')).toContain('品目を読み取れませんでした');
    expect(draft.warnings.join('')).toContain('日付を読み取れませんでした');
  });

  it('JSON が壊れていても落ちずに手入力を促す', () => {
    const draft = normalizeDraft('読み取れませんでした');
    expect(draft.items).toHaveLength(0);
    expect(draft.warnings[0]).toContain('手で入れて');
  });

  it('合計が無ければ品目の合計で埋める', () => {
    const draft = normalizeDraft(
      '{"storeName":"店","date":"2026-09-01","items":[{"name":"おにぎり","amount":150},{"name":"お茶","amount":130}]}'
    );
    expect(draft.total).toBe(280);
    expect(draft.warnings.join('')).toContain('合計を読み取れませんでした');
  });

  it('値引きの負の金額をそのまま持つ', () => {
    const draft = normalizeDraft(
      '{"storeName":"店","date":"2026-09-01","total":1150,"items":[{"name":"おにぎり","amount":1200},{"name":"クーポン値引","amount":-50}]}'
    );
    expect(draft.items[1].amount).toBe(-50);
    expect(draft.items[1].categoryId).toBe('discount');
  });

  /* タリーズのレシートで実際に起きた読み違い。「モーニングセット -¥100」を +100 で返してきた */
  it('値引きを正の金額で読んだ品目が 1 つに決まれば負に直す', () => {
    const draft = normalizeDraft(
      '{"storeName":"タリーズコーヒー","date":"2026-09-08","total":820,"items":[{"name":"アイスGコーヒー","amount":510},{"name":"イングリッシュマフィンツナチーズ","amount":410},{"name":"モーニングセット","amount":100}]}',
      new Date('2026-09-08T12:00:00+09:00'),
    );
    expect(draft.items.map((item) => item.amount)).toEqual([510, 410, -100]);
    expect(draft.items[2].categoryId).toBe('discount');
    expect(draft.warnings.join('')).toContain('「モーニングセット」を値引き');
    expect(draft.warnings.join('')).not.toContain('離れています');
  });

  it('負に直す候補が複数あれば触らずに注意だけ残す', () => {
    const draft = normalizeDraft(
      '{"storeName":"店","date":"2026-09-08","total":300,"items":[{"name":"A","amount":100},{"name":"B","amount":100},{"name":"C","amount":300}]}',
      new Date('2026-09-08T12:00:00+09:00'),
    );
    expect(draft.items.map((item) => item.amount)).toEqual([100, 100, 300]);
    expect(draft.warnings.join('')).toContain('離れています');
  });

  it('読めない欄の null は空として扱い、金額の読めない品目は数を知らせる', () => {
    const draft = normalizeDraft(
      '{"lines":["…"],"storeName":null,"date":null,"total":null,"items":[{"name":"おにぎり","amount":150},{"name":"お茶","amount":null}]}',
      new Date('2026-09-08T12:00:00+09:00'),
    );
    expect(draft.storeName).toBe('');
    expect(draft.date).toBe('');
    expect(draft.items).toHaveLength(1);
    const warnings = draft.warnings.join('');
    expect(warnings).toContain('金額を読めなかった品目が 1 件');
    expect(warnings).toContain('店名を読み取れませんでした');
    expect(warnings).toContain('合計を読み取れませんでした');
  });

  it('先の日付や 1 年以上前の日付は読み違いを疑う', () => {
    const today = new Date('2026-09-08T12:00:00+09:00');
    const body = (date: string) => `{"storeName":"店","date":"${date}","total":150,"items":[{"name":"おにぎり","amount":150}]}`;
    expect(normalizeDraft(body('2026-09-08'), today).warnings).toEqual([]);
    expect(normalizeDraft(body('2026-12-01'), today).warnings.join('')).toContain('先の日付');
    expect(normalizeDraft(body('2022-06-20'), today).warnings.join('')).toContain('1 年以上前');
  });
});

describe('normalizeDraft の支払い方法', () => {
  const body = (payment: string) =>
    `{"storeName":"店","date":"2026-09-08","total":150,"paymentMethod":${payment},"items":[{"name":"おにぎり","amount":150}]}`;
  const today = new Date('2026-09-08T12:00:00+09:00');

  it('読めた支払い方法を返す', () => {
    expect(normalizeDraft(body('"suica"'), today).paymentMethod).toBe('suica');
    expect(normalizeDraft(body('"paypay"'), today).paymentMethod).toBe('paypay');
  });

  it('読めない、または選択肢に無い支払い方法は持たない', () => {
    expect(normalizeDraft(body('null'), today)).not.toHaveProperty('paymentMethod');
    expect(normalizeDraft(body('"商品券"'), today)).not.toHaveProperty('paymentMethod');
  });
});

describe('normalizeDraft（ドルのレシート）', () => {
  const today = new Date('2026-10-05T12:00:00+09:00');

  it('ドルの金額はセントの整数に直し、通貨を返す', () => {
    const draft = normalizeDraft(
      '{"storeName":"Starbucks","date":"2026-10-03","currency":"USD","total":12.34,"items":[{"name":"Latte","amount":5.95},{"name":"Croissant","amount":"$5.25"}]}',
      today,
    );
    expect(draft.currency).toBe('USD');
    expect(draft.total).toBe(1234);
    expect(draft.items.map((item) => item.amount)).toEqual([595, 525]);
    expect(draft.warnings).toContain('ドルのレシートとして読みました。円に直すレートを確かめてください。');
  });

  it('値引きの読み違いもセントで直し、ドルで知らせる', () => {
    const draft = normalizeDraft(
      '{"storeName":"Store","date":"2026-10-03","currency":"USD","total":9.50,"items":[{"name":"Item","amount":10.00},{"name":"Coupon","amount":0.50}]}',
      today,
    );
    expect(draft.items.map((item) => item.amount)).toEqual([1000, -50]);
    expect(draft.warnings).toContain('「Coupon」を値引き（-$0.50）として入れました。違っていたら直してください。');
  });

  it('通貨が無い、または JPY なら円として扱い、currency を持たない', () => {
    const draft = normalizeDraft('{"storeName":"店","date":"2026-10-03","total":1200,"items":[{"name":"おにぎり","amount":150}]}', today);
    expect(draft).not.toHaveProperty('currency');
    expect(draft.total).toBe(1200);
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
