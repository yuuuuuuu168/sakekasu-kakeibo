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
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';

const TABLE_NAME = requireEnv('TABLE_NAME');
const RECEIPT_BUCKET = requireEnv('RECEIPT_BUCKET');

const documents = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const s3 = new S3Client({});

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

  try {
    return await route(sub, method, segments, body);
  } catch (cause) {
    if (cause instanceof BadRequest) return json(400, { message: cause.message });
    console.error('[api] unhandled', cause);
    return json(500, { message: '処理に失敗しました' });
  }
}

class BadRequest extends Error {}

async function route(sub: string, method: string, segments: string[], body: Json): Promise<APIGatewayProxyResultV2> {
  const [resource, param] = segments;

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
    if (method === 'POST' && param === 'analyze') {
      // このパスは OCR 用の Lambda が直接受ける。ここに来るのは経路の設定ミス
      return json(500, { message: 'OCR の経路が設定されていません' });
    }
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
        PutRequest: { Item: { pk: `USER#${sub}`, sk: SK.transaction(txn.id), ...txn } },
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

  return txn as Json & { id: string };
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

/** レシート画像の置き場所を用意する。画像そのものは API を通さず S3 へ直接送らせる */
async function createUpload(sub: string, body: Json): Promise<APIGatewayProxyResultV2> {
  const contentType = typeof body.contentType === 'string' ? body.contentType : 'image/jpeg';
  if (!contentType.startsWith('image/')) throw new BadRequest('画像だけ受け取れます');

  const extension = contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg';
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
