import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { RECEIPT_IMAGE_TYPES, isReceiptImageType } from '@kakeibo/core';
import {
  OCR_JOB_STALE_MS,
  OCR_JOB_TTL_SECONDS,
  ocrJobKey,
  parseKeys,
  type OcrJobRequest,
  type OcrJobStatus,
} from '../shared/ocr-job';

const TABLE_NAME = requireEnv('TABLE_NAME');
const RECEIPT_BUCKET = requireEnv('RECEIPT_BUCKET');
const OCR_FUNCTION_NAME = requireEnv('OCR_FUNCTION_NAME');

const documents = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const s3 = new S3Client({});
const lambda = new LambdaClient({});

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/** 1 回の取り込みで受け取る明細の上限。取り込み画面は 1 ファイル分しか送らない */
const MAX_TRANSACTIONS_PER_REQUEST = 2000;

type Json = Record<string, unknown>;

const SK = {
  transaction: (id: string) => `TXN#${id}`,
  categories: 'CONFIG#categories',
  rules: 'CONFIG#rules',
  recurring: 'CONFIG#recurring',
  budget: (month: string) => `BUDGET#${month}`,
  mapping: (sourceId: string) => `MAPPING#${sourceId}`,
  receipt: (id: string) => `RECEIPT#${id}`,
  report: (month: string) => `REPORT#${month}`,
};

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> {
  const sub = event.requestContext.authorizer?.jwt?.claims?.sub;
  if (typeof sub !== 'string' || sub === '') return json(401, { message: 'サインインが必要です' });

  const method = event.requestContext.http.method;
  const segments = (event.rawPath ?? '').split('/').filter(Boolean);
  const body = parseBody(event.body, event.isBase64Encoded);
  const started = Date.now();

  let reason: string | undefined;
  const result = await (async () => {
    try {
      return await route(sub, method, segments, body);
    } catch (cause) {
      if (cause instanceof BadRequest) {
        reason = cause.message;
        return json(400, { message: cause.message });
      }
      console.error('[api] unhandled', cause);
      return json(500, { message: '処理に失敗しました' });
    }
  })();

  const status = typeof result === 'object' && result.statusCode !== undefined ? result.statusCode : 200;
  // 文字列にして 1 行で出す。オブジェクトのまま渡すと、入れ子の深いところが [Object] に潰れる
  console.info(
    '[api]',
    JSON.stringify({
      操作: `${method} /${segments.join('/')}`,
      状態: status,
      所要ms: Date.now() - started,
      ...(reason ? { 理由: reason } : {}),
      ...describeRequest(method, segments, body),
    }),
  );
  return result;
}

/** 1 回のログに中身まで並べる明細の数。取り込みは 1 回で 2,000 件まで来るので、全部並べると 1 行が大きくなりすぎる */
export const LOGGED_TRANSACTIONS = 50;

/**
 * ログに残す、保存した中身。あとから「何がどのカテゴリで保存されたか」を CloudWatch で追えるようにする。
 * 金額・品目名・店舗名は出す（利用者が出してよいと決めた）。sub とトークンは出さない。
 * 件数とカテゴリ別の行数は全件で数え、明細の中身は先頭の LOGGED_TRANSACTIONS 件まで並べる。
 */
export function describeRequest(method: string, segments: string[], body: Json): Json {
  if (method !== 'PUT') return {};
  const [resource, param] = segments;

  if (resource === 'transactions') {
    const transactions = param === undefined ? (asArray(body.transactions) as Json[]) : [{ ...body, id: param }];
    return {
      明細: transactions.length,
      内訳のカテゴリ: countCategories(transactions.flatMap((txn) => asArray(txn?.splits))),
      中身: transactions.slice(0, LOGGED_TRANSACTIONS).map(describeTransaction),
      ...(transactions.length > LOGGED_TRANSACTIONS ? { 省いた明細: transactions.length - LOGGED_TRANSACTIONS } : {}),
    };
  }
  if (resource === 'receipts' && param) {
    return {
      レシート: param,
      店: body.storeName,
      日付: body.date,
      合計: body.total,
      品目のカテゴリ: countCategories(asArray(body.items)),
      品目: asArray(body.items).map((item) => describeLine(item as Json)),
    };
  }
  if (resource === 'categories' || resource === 'rules' || resource === 'recurring') {
    return { 件数: asArray(body[resource]).length };
  }
  return {};
}

function describeTransaction(txn: Json): Json {
  return {
    id: txn?.id,
    日付: txn?.date,
    店: txn?.rawMerchant,
    金額: txn?.amount,
    ...(txn?.receiptId ? { レシート: txn.receiptId } : {}),
    内訳: asArray(txn?.splits).map((split) => describeLine(split as Json)),
  };
}

/** 内訳や品目の 1 行。[品目名, カテゴリ, 金額] の並びにして、1 行を短く保つ */
function describeLine(line: Json): unknown[] {
  return [line?.name ?? '', line?.categoryId ?? '', line?.amount];
}

/** カテゴリ ID ごとの行数。負の金額の行は別に数え、値引きがどこに入ったかを追えるようにする */
function countCategories(rows: unknown[]): Json {
  const counts: Record<string, number> = {};
  let negative = 0;
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const { categoryId, amount } = row as Json;
    const key = typeof categoryId === 'string' && categoryId !== '' ? categoryId : '(なし)';
    counts[key] = (counts[key] ?? 0) + 1;
    if (typeof amount === 'number' && amount < 0) negative += 1;
  }
  return { ...counts, ...(negative > 0 ? { 負の行: negative } : {}) };
}

class BadRequest extends Error {}

async function route(sub: string, method: string, segments: string[], body: Json): Promise<APIGatewayProxyResultV2> {
  const [resource, param, child] = segments;

  if (method === 'GET' && resource === 'snapshot') return json(200, await loadSnapshot(sub));

  if (resource === 'transactions') {
    if (method === 'PUT' && param === undefined) return putTransactions(sub, body);
    if (method === 'PUT' && param) return putTransaction(sub, param, body);
    if (method === 'DELETE' && param) return remove(sub, SK.transaction(param));
  }

  if (method === 'PUT' && resource === 'categories') {
    return putConfig(sub, SK.categories, 'categories', body);
  }

  if (method === 'PUT' && resource === 'rules') {
    return putConfig(sub, SK.rules, 'rules', body);
  }

  if (method === 'PUT' && resource === 'recurring') {
    return putConfig(sub, SK.recurring, 'recurring', body);
  }

  if (method === 'PUT' && resource === 'budgets' && param) {
    assertMonth(param);
    const limits = body.limits;
    if (typeof limits !== 'object' || limits === null) throw new BadRequest('limits が要ります');
    await put(sub, SK.budget(param), { month: param, limits });
    return json(204, undefined);
  }

  if (method === 'PUT' && resource === 'mappings' && param) {
    await put(sub, SK.mapping(param), body);
    return json(204, undefined);
  }

  if (resource === 'receipts') {
    if (method === 'POST' && param === 'analyze' && child === undefined) return startOcrJob(sub, body);
    if (method === 'GET' && param === 'analyze' && child) return getOcrJob(sub, child);
    if (method === 'PUT' && param) {
      await put(sub, SK.receipt(param), { ...body, id: param });
      return json(204, undefined);
    }
    if (method === 'DELETE' && param) return remove(sub, SK.receipt(param));
  }

  if (method === 'POST' && resource === 'uploads') return createUpload(sub, body);

  if (method === 'GET' && resource === 'reports' && param) {
    assertMonth(param);
    const found = await documents.send(
      new GetCommand({ TableName: TABLE_NAME, Key: { pk: `USER#${sub}`, sk: SK.report(param) } }),
    );
    if (!found.Item) return json(404, { message: 'この月のレポートはまだありません' });
    return json(200, found.Item.report);
  }

  return json(404, { message: 'そのような操作はありません' });
}

async function loadSnapshot(sub: string) {
  const items: Json[] = [];
  let startKey: Record<string, unknown> | undefined;

  do {
    const page = await documents.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': `USER#${sub}` },
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    items.push(...((page.Items ?? []) as Json[]));
    startKey = page.LastEvaluatedKey;
  } while (startKey);

  const snapshot = {
    categories: [] as unknown[],
    rules: [] as unknown[],
    budgets: [] as unknown[],
    transactions: [] as unknown[],
    receipts: [] as unknown[],
    mappings: [] as unknown[],
    recurring: [] as unknown[],
  };

  for (const item of items) {
    const sk = String(item.sk);
    if (sk.startsWith('TXN#')) snapshot.transactions.push(strip(item));
    else if (sk === SK.categories) snapshot.categories = asArray(item.categories);
    else if (sk === SK.rules) snapshot.rules = asArray(item.rules);
    else if (sk === SK.recurring) snapshot.recurring = asArray(item.recurring);
    else if (sk.startsWith('BUDGET#')) snapshot.budgets.push(strip(item));
    else if (sk.startsWith('RECEIPT#')) snapshot.receipts.push(strip(item));
    else if (sk.startsWith('MAPPING#')) snapshot.mappings.push(strip(item));
  }

  return snapshot;
}

/** DynamoDB のキーは画面に要らないので落とす */
function strip(item: Json): Json {
  const { pk: _pk, sk: _sk, ...rest } = item;
  return rest;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

async function putTransactions(sub: string, body: Json): Promise<APIGatewayProxyResultV2> {
  const transactions = body.transactions;
  if (!Array.isArray(transactions)) throw new BadRequest('transactions が要ります');
  if (transactions.length === 0) return json(204, undefined);
  if (transactions.length > MAX_TRANSACTIONS_PER_REQUEST) {
    throw new BadRequest(`一度に送れる明細は ${MAX_TRANSACTIONS_PER_REQUEST} 件までです`);
  }

  const rows = transactions.map((txn) => assertTransaction(txn));

  // BatchWrite は 25 件ずつ。書き込みは上書きでよい（重複の判定は取り込み画面で済んでいる）
  for (let index = 0; index < rows.length; index += 25) {
    const chunk = rows.slice(index, index + 25);
    let request: Record<string, unknown[]> | undefined = {
      [TABLE_NAME]: chunk.map((txn) => ({
        // キーは展開の後ろに置く。本文に pk / sk があっても、sub から組み立てた値が勝つ
        PutRequest: { Item: { ...txn, pk: `USER#${sub}`, sk: SK.transaction(txn.id) } },
      })),
    };

    // 未処理分は返ってくるので、空になるまで送り直す
    for (let attempt = 0; attempt < 5 && request && Object.keys(request).length > 0; attempt += 1) {
      const result = await documents.send(new BatchWriteCommand({ RequestItems: request as never }));
      request = result.UnprocessedItems as Record<string, unknown[]> | undefined;
      if (request && Object.keys(request).length > 0) {
        await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
      }
    }
  }

  return json(204, undefined);
}

async function putTransaction(sub: string, id: string, body: Json): Promise<APIGatewayProxyResultV2> {
  const txn = assertTransaction({ ...body, id });
  await put(sub, SK.transaction(id), txn);
  return json(204, undefined);
}

/**
 * 内訳の合計が明細の金額に一致していることだけは、保存の前にここでも見る。
 * 画面側（packages/core）が守っている不変条件だが、壊れた状態を保存すると
 * カテゴリ別の集計が静かに狂うので、境界で止める。
 */
export function assertTransaction(value: unknown): Json & { id: string } {
  if (typeof value !== 'object' || value === null) throw new BadRequest('明細の形が違います');
  const txn = value as Json;
  if (typeof txn.id !== 'string' || txn.id === '') throw new BadRequest('明細に id がありません');
  if (typeof txn.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(txn.date)) {
    throw new BadRequest(`明細 ${txn.id} の日付が YYYY-MM-DD ではありません`);
  }
  if (typeof txn.amount !== 'number' || !Number.isInteger(txn.amount)) {
    throw new BadRequest(`明細 ${txn.id} の金額が整数ではありません`);
  }
  if (!Array.isArray(txn.splits) || txn.splits.length === 0) {
    throw new BadRequest(`明細 ${txn.id} に内訳がありません`);
  }

  let total = 0;
  for (const split of txn.splits as Json[]) {
    if (typeof split?.amount !== 'number' || !Number.isInteger(split.amount)) {
      throw new BadRequest(`明細 ${txn.id} の内訳の金額が整数ではありません`);
    }
    if (typeof split?.categoryId !== 'string' || split.categoryId === '') {
      throw new BadRequest(`明細 ${txn.id} の内訳にカテゴリがありません`);
    }
    total += split.amount;
  }
  if (total !== txn.amount) {
    throw new BadRequest(`明細 ${txn.id} の内訳の合計 ${total} が金額 ${txn.amount} と合いません`);
  }

  // 本文の pk / sk は保存に使わない。キーは呼び出し側が sub から組み立てる
  return strip(txn) as Json & { id: string };
}

async function putConfig(sub: string, sk: string, field: string, body: Json): Promise<APIGatewayProxyResultV2> {
  const value = body[field];
  if (!Array.isArray(value)) throw new BadRequest(`${field} が要ります`);
  await put(sub, sk, { [field]: value });
  return json(204, undefined);
}

async function put(sub: string, sk: string, attributes: Json): Promise<void> {
  await documents.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: { ...attributes, pk: `USER#${sub}`, sk, updatedAt: new Date().toISOString() },
    }),
  );
}

async function remove(sub: string, sk: string): Promise<APIGatewayProxyResultV2> {
  await documents.send(new DeleteCommand({ TableName: TABLE_NAME, Key: { pk: `USER#${sub}`, sk } }));
  return json(204, undefined);
}

/**
 * レシートの読み取りを受け付ける。ジョブの行を作り、ocr-receipt を非同期で呼んで、すぐ jobId を返す。
 * 読み取りは API Gateway の 30 秒を超えうるので、ここでは待たない（shared/ocr-job.ts）。
 */
async function startOcrJob(sub: string, body: Json): Promise<APIGatewayProxyResultV2> {
  const parsed = parseKeys(body, sub);
  if ('error' in parsed) {
    if (parsed.status === 403) {
      console.warn('[api] ocr key does not belong to caller', { sub, keys: parsed.keys });
      return json(403, { message: parsed.error });
    }
    throw new BadRequest(parsed.error);
  }
  const { keys } = parsed;

  const jobId = randomUUID();
  const now = Date.now();
  await documents.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        ...ocrJobKey(sub, jobId),
        status: 'pending' satisfies OcrJobStatus,
        keys,
        createdAt: new Date(now).toISOString(),
        expiresAt: Math.floor(now / 1000) + OCR_JOB_TTL_SECONDS,
      },
    }),
  );

  const request: OcrJobRequest = { jobId, sub, keys };
  await lambda.send(
    new InvokeCommand({
      FunctionName: OCR_FUNCTION_NAME,
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify(request)),
    }),
  );

  return json(202, { jobId });
}

/**
 * 読み取りの結果を返す。pending のまま OCR_JOB_STALE_MS を過ぎたジョブは、読み取りの Lambda が
 * 落ちた（タイムアウトなど）とみなして failed で返す。行は書き換えない。遅れて結果が書かれても害は無い。
 */
async function getOcrJob(sub: string, jobId: string): Promise<APIGatewayProxyResultV2> {
  const { Item } = await documents.send(new GetCommand({ TableName: TABLE_NAME, Key: ocrJobKey(sub, jobId) }));
  if (!Item) return json(404, { message: '読み取りの受付が見つかりません' });

  const status = Item.status as OcrJobStatus;
  if (status === 'done') return json(200, { status, draft: Item.draft });
  if (status === 'failed') return json(200, { status, message: Item.message });

  const elapsed = Date.now() - Date.parse(String(Item.createdAt));
  if (elapsed > OCR_JOB_STALE_MS) {
    return json(200, { status: 'failed', message: '時間内に読み取れませんでした。もう一度お試しください' });
  }
  return json(200, { status: 'pending' });
}

/** レシート画像の置き場所を用意する。画像そのものは API を通さず S3 へ直接送らせる */
async function createUpload(sub: string, body: Json): Promise<APIGatewayProxyResultV2> {
  const contentType = typeof body.contentType === 'string' ? body.contentType : 'image/jpeg';
  // OCR が読める 3 つだけ。SVG などを置かせない（core の RECEIPT_IMAGE_TYPES に理由がある）
  if (!isReceiptImageType(contentType)) throw new BadRequest('JPEG・PNG・WebP の画像だけ受け取れます');

  const extension = RECEIPT_IMAGE_TYPES[contentType];
  const key = `receipts/${sub}/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.${extension}`;

  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: RECEIPT_BUCKET, Key: key, ContentType: contentType }),
    { expiresIn: 300 },
  );

  return json(200, { uploadUrl, key });
}

function assertMonth(month: string): void {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new BadRequest('月は YYYY-MM で指定してください');
}

function parseBody(body: string | undefined, isBase64Encoded: boolean | undefined): Json {
  if (!body) return {};
  const text = isBase64Encoded ? Buffer.from(body, 'base64').toString('utf-8') : body;
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Json) : {};
  } catch {
    return {};
  }
}

function json(statusCode: number, payload: unknown): APIGatewayProxyResultV2 {
  if (payload === undefined) return { statusCode, body: '' };
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload),
  };
}
