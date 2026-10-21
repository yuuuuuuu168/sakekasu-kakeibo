import { randomUUID } from 'node:crypto';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { RECEIPT_IMAGE_TYPES, isReceiptImageType } from '@kakeibo/core';
import { requireEnv } from '../shared/env';
import { json, type Json } from '../shared/http';
import {
  OCR_JOB_STALE_MS,
  OCR_JOB_TTL_SECONDS,
  ocrJobKey,
  parseKeys,
  type OcrJobRequest,
  type OcrJobStatus,
} from '../shared/ocr-job';
import { TABLE_NAME, documents } from './store';
import { BadRequest } from './validate';

/*
 * レシートの画像の置き場所と、読み取りのジョブ。画像は API を通さず S3 へ直接送らせ、
 * 読み取りは ocr-receipt を非同期で呼んでジョブの行で結果を受け渡す（shared/ocr-job.ts）。
 */

const RECEIPT_BUCKET = requireEnv('RECEIPT_BUCKET');
const OCR_FUNCTION_NAME = requireEnv('OCR_FUNCTION_NAME');

const s3 = new S3Client({});
const lambda = new LambdaClient({});

/**
 * レシートの読み取りを受け付ける。ジョブの行を作り、ocr-receipt を非同期で呼んで、すぐ jobId を返す。
 * 読み取りは API Gateway の 30 秒を超えうるので、ここでは待たない（shared/ocr-job.ts）。
 */
export async function startOcrJob(sub: string, body: Json): Promise<APIGatewayProxyResultV2> {
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
export async function getOcrJob(sub: string, jobId: string): Promise<APIGatewayProxyResultV2> {
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
export async function createUpload(sub: string, body: Json): Promise<APIGatewayProxyResultV2> {
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
