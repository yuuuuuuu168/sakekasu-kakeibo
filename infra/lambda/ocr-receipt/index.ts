import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { classifyItem, toYen } from '@kakeibo/core';
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

  const body = parseBody(event.body, event.isBase64Encoded);
  const key = typeof body.key === 'string' ? body.key : '';
  if (!key) return json(400, { message: '画像のキーが要ります' });

  // 自分が上げた画像だけを読ませる。キーの組み立ては API 側と揃えてある
  if (!key.startsWith(`receipts/${sub}/`)) {
    console.warn('[ocr] key does not belong to caller', { sub, key });
    return json(403, { message: 'その画像は読めません' });
  }

  try {
    const image = await loadImage(key);
    const draft = await analyze(image);
    return json(200, draft);
  } catch (cause) {
    console.error('[ocr] failed', cause);
    const message = cause instanceof Error ? cause.message : 'レシートの読み取りに失敗しました';
    return json(502, { message });
  }
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
 */
function buildPrompt(): string {
  return `このレシートの写真から、次の JSON だけを返してください。前後に説明や\`\`\`を付けないこと。

{
  "storeName": "店舗名",
  "date": "YYYY-MM-DD",
  "total": 合計金額の整数,
  "items": [
    { "name": "品目名", "amount": 金額の整数, "quantity": 個数 }
  ]
}

決まり。
- 金額は円の整数。カンマや円記号を含めない
- 値引き・ポイント値引きは負の金額の品目として入れる
- 小計・合計・お預り・お釣り・消費税は items に入れない
- 日付が読めなければ date を空文字にする
- 品目名は印字されたまま。略字はそのまま書く`;
}

async function analyze(
  image: { base64: string; mediaType: string },
): Promise<{ storeName: string; date: string; total: number; items: unknown[]; warnings: string[] }> {
  const response = await bedrock.send(
    new InvokeModelCommand({
      modelId: MODEL_ID,
      contentType: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 2048,
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } },
              { type: 'text', text: buildPrompt() },
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

/**
 * モデルの出力を家計簿が扱える形に直す。
 * JSON が壊れていること、金額が文字列で来ることがいずれも起きるので、
 * 全部ここで吸収して warnings に残す。
 *
 * カテゴリはキーワード表（classifyItem）で仮に付ける。本番の判定は画面が
 * この後 /classify に聞きに行くので、ここで付けるのはその返事が来ないときの控え。
 */
export function normalizeDraft(
  text: string,
): { storeName: string; date: string; total: number; items: { name: string; amount: number; quantity?: number; categoryId: string }[]; warnings: string[] } {
  const warnings: string[] = [];
  const parsed = extractJson(text);
  if (!parsed) {
    return { storeName: '', date: '', total: 0, items: [], warnings: ['レシートを読み取れませんでした。手で入れてください。'] };
  }

  const items = (Array.isArray(parsed.items) ? (parsed.items as RawItem[]) : [])
    .map((item) => {
      const name = typeof item.name === 'string' ? item.name.trim() : '';
      const amount = toNumber(item.amount);
      if (name === '' || amount === undefined) return undefined;
      return {
        name,
        amount: toYen(amount),
        ...(toNumber(item.quantity) !== undefined ? { quantity: toNumber(item.quantity) } : {}),
        categoryId: classifyItem(name),
      };
    })
    .filter((item): item is { name: string; amount: number; quantity?: number; categoryId: string } => item !== undefined);

  const total = toNumber(parsed.total);
  const itemsTotal = items.reduce((sum, item) => sum + item.amount, 0);

  if (total === undefined) warnings.push('合計を読み取れませんでした。入れ直してください。');
  else if (items.length > 0 && Math.abs(toYen(total) - itemsTotal) > Math.max(50, Math.round(total * 0.1))) {
    warnings.push(`品目の合計（${itemsTotal} 円）が合計（${toYen(total)} 円）と離れています。読み落としがあるかもしれません。`);
  }
  if (items.length === 0) warnings.push('品目を読み取れませんでした。手で足してください。');

  const date = typeof parsed.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date) ? parsed.date : '';
  if (date === '') warnings.push('日付を読み取れませんでした。');

  return {
    storeName: typeof parsed.storeName === 'string' ? parsed.storeName.trim() : '',
    date,
    total: total === undefined ? itemsTotal : toYen(total),
    items,
    warnings,
  };
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
    const cleaned = value.replace(/[,¥円\s]/g, '');
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
