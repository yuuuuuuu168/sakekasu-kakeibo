import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  MAX_RECEIPT_PHOTOS,
  classifyItem,
  formatMoney,
  toMinor,
  toPaymentMethod,
  type Currency,
  type SourceKind,
} from '@kakeibo/core';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';

const RECEIPT_BUCKET = requireEnv('RECEIPT_BUCKET');
/**
 * Bedrock のモデル ID は環境変数から取り、既定値を持たない。
 * IAM はこのモデルの ARN だけを許可しているので、ここに書き残すと設定漏れが
 * AccessDeniedException として出てくる。設定漏れは設定漏れとして出す。
 * （sakekasu-builder の ocr-analyzer と同じ考え方）
 */
const MODEL_ID = requireEnv('BEDROCK_MODEL_ID');

/** Bedrock が受け取れる画像の上限。base64 にした後の長さで判定される */
const BASE64_LIMIT = 5 * 1024 * 1024;

const bedrock = new BedrockRuntimeClient({});
const s3 = new S3Client({});

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

type RawItem = {
  name?: unknown;
  amount?: unknown;
  quantity?: unknown;
};

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> {
  const sub = event.requestContext.authorizer?.jwt?.claims?.sub;
  if (typeof sub !== 'string' || sub === '') return json(401, { message: 'サインインが必要です' });

  const parsed = parseKeys(parseBody(event.body, event.isBase64Encoded), sub);
  if ('error' in parsed) {
    if (parsed.status === 403) console.warn('[ocr] key does not belong to caller', { sub, keys: parsed.keys });
    return json(parsed.status, { message: parsed.error });
  }

  try {
    const images = await Promise.all(parsed.keys.map(loadImage));
    const draft = await analyze(images);
    return json(200, draft);
  } catch (cause) {
    console.error('[ocr] failed', cause);
    const message = cause instanceof Error ? cause.message : 'レシートの読み取りに失敗しました';
    return json(502, { message });
  }
}

/**
 * 読む写真のキーを取り出す。1 枚なら `key`、分けて撮った長いレシートなら `keys`（上から順）。
 * どのキーも呼び出した人が上げたものに限る。キーの組み立ては API 側と揃えてある。
 */
export function parseKeys(
  body: Record<string, unknown>,
  sub: string,
): { keys: string[] } | { error: string; status: 400 | 403; keys?: string[] } {
  const keys = Array.isArray(body.keys)
    ? body.keys.filter((key): key is string => typeof key === 'string' && key !== '')
    : typeof body.key === 'string' && body.key !== ''
      ? [body.key]
      : [];
  if (keys.length === 0 || (Array.isArray(body.keys) && keys.length !== body.keys.length)) {
    return { error: '画像のキーが要ります', status: 400 };
  }
  if (keys.length > MAX_RECEIPT_PHOTOS) {
    return { error: `一度に読めるのは ${MAX_RECEIPT_PHOTOS} 枚までです`, status: 400 };
  }
  if (new Set(keys).size !== keys.length) return { error: '同じ写真が重なっています', status: 400 };
  const foreign = keys.filter((key) => !key.startsWith(`receipts/${sub}/`));
  if (foreign.length > 0) return { error: 'その画像は読めません', status: 403, keys: foreign };
  return { keys };
}

async function loadImage(key: string): Promise<{ base64: string; mediaType: string }> {
  const object = await s3.send(new GetObjectCommand({ Bucket: RECEIPT_BUCKET, Key: key }));
  if (!object.Body) throw new Error('画像が見つかりません');

  const bytes = await object.Body.transformToByteArray();
  const mediaType = sniffMediaType(bytes);
  if (!mediaType) throw new Error('画像として読めない形式です');

  const base64 = Buffer.from(bytes).toString('base64');
  if (base64.length > BASE64_LIMIT) throw new Error('画像が大きすぎます。撮り直すか縮小してください');
  return { base64, mediaType };
}

/**
 * 中身のバイト列から形式を決める。S3 の ContentType はアップロード側の申告で、
 * 信じると非画像のバイナリが image/jpeg として Bedrock に届く。
 */
export function sniffMediaType(bytes: Uint8Array): string | undefined {
  if (bytes.length < 12) return undefined;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  const riff = String.fromCharCode(...bytes.slice(0, 4));
  const webp = String.fromCharCode(...bytes.slice(8, 12));
  if (riff === 'RIFF' && webp === 'WEBP') return 'image/webp';
  return undefined;
}

/**
 * カテゴリは聞かない。このモデルに任せるのは「印字を読む」ところまでで、
 * どの費目かは別の関数（classify）が Jev に聞く。仕事を 1 つにすると
 * 出力が短くなり、JSON が壊れる目も減る。
 *
 * `lines` を先頭に置いているのは、項目を埋める前に印字を書き起こさせるため。
 * JSON は前から順に生成されるので、先に全体を読ませてから値を拾わせる形になる。
 * いきなり項目を埋めさせると、読めていない欄をそれらしい値で埋めてくる。
 */
function buildPrompt(photos: number): string {
  const intro =
    photos > 1
      ? `1 枚の長いレシートを ${photos} 枚に分けて撮った写真です。つなげて 1 枚のレシートとして読んでください。写真の並びは前後していることがあります。店名のある写真が先頭、合計のある写真が末尾になるよう、印字のつながりで並べてから読むこと。境目は重ねて撮っていることがあるので、2 枚に写っている同じ行は 1 回だけ数えること。`
      : 'レシートの写真です。';
  return `${intro}ほとんどは日本の円のレシートで、たまに米ドルのレシートがあります。次の JSON だけを返してください。前後に説明や\`\`\`を付けないこと。

{
  "lines": ["印字を上から 1 行ずつ書き起こしたもの"],
  "storeName": "店舗名" または null,
  "date": "YYYY-MM-DD" または null,
  "currency": "JPY" | "USD",
  "total": 合計金額 または null,
  "paymentMethod": "cash" | "paypay" | "credit" | "suica" または null,
  "items": [
    { "name": "品目名", "amount": 金額 または null, "quantity": 個数 }
  ]
}

読み方。
- 写真は 90 度や 180 度回っていることがある。文字の向きに合わせて読む
- まず lines に印字をそのまま書き起こし、その後で lines から各項目を拾う
- 読めない欄は推測で埋めず null にする。それらしい値を作らないこと
- 半角カナは全角カタカナに直す。濁点・半濁点が別の文字に分かれて印字されていても 1 文字にまとめる（ｸﾞ → グ、ﾊﾟ → パ）

決まり。
- currency は印字の通貨。$ や USD の印字があれば USD、それ以外は JPY
- 金額は印字の通貨のまま数で書く。円は整数、ドルはセントまでの小数（$12.34 は 12.34）。カンマや通貨記号を含めない
- 値引き・割引・セット割・クーポン・ポイント値引きは負の金額の品目として入れる。「-¥100」「▲100」「△100」「100-」はどれも -100
- 小計・合計・お預り・お釣り・消費税・対象額・点数・支払方法（交通系・クレジット等）は items に入れない。ドルのレシートの Subtotal・Tax・Tip・Change も同じ
- total は「合計」（Total）の金額。「小計」「お預り」「対象」ではない
- 店舗名はチェーン名と店名をつなげる（例: タリーズコーヒー 横浜駅店）
- 日付は取引日。キャンペーンや有効期限の日付と取り違えない。ドルのレシートの 10/03/2026 のような日付は月/日/年
- paymentMethod は支払いの行から決める。お預り・現計は cash、PayPay は paypay、
  クレジット・カード・VISA などは credit、交通系・Suica・PASMO・ICOCA などの交通系 IC は suica。
  支払いの印字が無い、またはこの 4 つのどれでもない（他の QR 決済・電子マネー・商品券など）なら null
- 品目名は印字の通り。略字はそのまま書く`;
}

async function analyze(
  images: { base64: string; mediaType: string }[],
): Promise<ReturnType<typeof normalizeDraft>> {
  const response = await bedrock.send(
    new InvokeModelCommand({
      modelId: MODEL_ID,
      contentType: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 4096,
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: [
              ...images.map((image) => ({
                type: 'image',
                source: { type: 'base64', media_type: image.mediaType, data: image.base64 },
              })),
              { type: 'text', text: buildPrompt(images.length) },
            ],
          },
        ],
      }),
    }),
  );

  const payload = JSON.parse(new TextDecoder().decode(response.body)) as { content?: { text?: string }[] };
  const text = payload.content?.map((part) => part.text ?? '').join('') ?? '';
  return normalizeDraft(text);
}

type DraftItem = { name: string; amount: number; quantity?: number; categoryId: string };

/**
 * モデルの出力を家計簿が扱える形に直す。
 * JSON が壊れていること、金額が文字列で来ることがいずれも起きるので、
 * 全部ここで吸収して warnings に残す。
 *
 * カテゴリはキーワード表（classifyItem）で仮に付ける。本番の判定は画面が
 * この後 /classify に聞きに行くので、ここで付けるのはその返事が来ないときの控え。
 *
 * `today` は日付の検算に使う。テストから固定できるように引数にしてある。
 */
export function normalizeDraft(
  text: string,
  today: Date = new Date(),
): {
  storeName: string;
  date: string;
  total: number;
  items: DraftItem[];
  /** ドルのときだけ入る。total と品目の amount はセント */
  currency?: Currency;
  paymentMethod?: SourceKind;
  warnings: string[];
} {
  const warnings: string[] = [];
  const parsed = extractJson(text);
  if (!parsed) {
    return { storeName: '', date: '', total: 0, items: [], warnings: ['レシートを読み取れませんでした。手で入れてください。'] };
  }

  // 金額は印字の通貨の最小単位（円、セント）の整数に直す。小数のドルを持ち込まない
  const currency: Currency = parsed.currency === 'USD' ? 'USD' : 'JPY';
  const toAmount = (value: number) => toMinor(value, currency);
  const money = (value: number) => formatMoney(value, currency);

  let unreadable = 0;
  const items = (Array.isArray(parsed.items) ? (parsed.items as RawItem[]) : [])
    .map((item) => {
      const name = typeof item.name === 'string' ? item.name.trim() : '';
      const amount = toNumber(item.amount);
      if (name !== '' && amount === undefined) unreadable += 1;
      if (name === '' || amount === undefined) return undefined;
      return {
        name,
        amount: toAmount(amount),
        ...(toNumber(item.quantity) !== undefined ? { quantity: toNumber(item.quantity) } : {}),
        categoryId: classifyItem(name, undefined, toAmount(amount)),
      };
    })
    .filter((item): item is DraftItem => item !== undefined);
  if (unreadable > 0) warnings.push(`金額を読めなかった品目が ${unreadable} 件あります。手で足してください。`);

  const rawTotal = toNumber(parsed.total);
  const total = rawTotal === undefined ? undefined : toAmount(rawTotal);

  const flipped = total === undefined ? undefined : flipDiscount(items, total);
  if (flipped) warnings.push(`「${flipped.name}」を値引き（${money(flipped.amount)}）として入れました。違っていたら直してください。`);

  const itemsTotal = items.reduce((sum, item) => sum + item.amount, 0);
  if (total === undefined) warnings.push('合計を読み取れませんでした。入れ直してください。');
  else if (items.length > 0 && Math.abs(total - itemsTotal) > Math.max(50, Math.round(total * 0.1))) {
    warnings.push(`品目の合計（${money(itemsTotal)}）が合計（${money(total)}）と離れています。読み落としがあるかもしれません。`);
  }
  if (items.length === 0) warnings.push('品目を読み取れませんでした。手で足してください。');

  const storeName = typeof parsed.storeName === 'string' ? parsed.storeName.trim() : '';
  if (storeName === '') warnings.push('店名を読み取れませんでした。');

  const date = typeof parsed.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date) ? parsed.date : '';
  if (date === '') warnings.push('日付を読み取れませんでした。');
  else {
    const doubt = doubtDate(date, today);
    if (doubt) warnings.push(doubt);
  }

  const paymentMethod = toPaymentMethod(parsed.paymentMethod);

  if (currency === 'USD') warnings.push('ドルのレシートとして読みました。円に直すレートを確かめてください。');

  return {
    storeName,
    date,
    total: total ?? itemsTotal,
    items,
    ...(currency === 'USD' ? { currency } : {}),
    ...(paymentMethod ? { paymentMethod } : {}),
    warnings,
  };
}

/**
 * 値引きの行を正の金額で読んでしまったものを 1 つだけ直す。
 * 品目の合計が合計より 2×a 多く、金額 a の正の品目がちょうど 1 つあるときに限り、
 * その品目を負にする。候補が複数あればどれか決められないので触らない。
 * 直した品目を返す（直さなければ undefined）。
 */
function flipDiscount(items: DraftItem[], total: number): DraftItem | undefined {
  const excess = items.reduce((sum, item) => sum + item.amount, 0) - total;
  if (excess <= 0 || excess % 2 !== 0) return undefined;
  const candidates = items.filter((item) => item.amount === excess / 2);
  if (candidates.length !== 1) return undefined;
  const target = candidates[0];
  target.amount = -target.amount;
  // 正の金額で付けたカテゴリ（食費など）のままだと、値引きが品目の側に混ざる
  target.categoryId = classifyItem(target.name, undefined, target.amount);
  return target;
}

/** 日本時間の今日から見て、レシートの日付として不自然なら理由を返す */
function doubtDate(date: string, today: Date): string | undefined {
  const day = Date.parse(`${date}T00:00:00+09:00`);
  if (Number.isNaN(day)) return '日付を読み取れませんでした。';
  const DAY = 24 * 60 * 60 * 1000;
  if (day > today.getTime() + DAY) return `日付（${date}）が先の日付になっています。読み違いかもしれません。`;
  if (day < today.getTime() - 365 * DAY) return `日付（${date}）が 1 年以上前です。読み違いかもしれません。`;
  return undefined;
}

function extractJson(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const cleaned = value.replace(/[,¥円$\s]/g, '').replace(/^USD/i, '');
    const parsed = Number(cleaned);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function parseBody(body: string | undefined, isBase64Encoded: boolean | undefined): Record<string, unknown> {
  if (!body) return {};
  const text = isBase64Encoded ? Buffer.from(body, 'base64').toString('utf-8') : body;
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function json(statusCode: number, payload: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload),
  };
}
