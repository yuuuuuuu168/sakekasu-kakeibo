import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ocrJobKey, parseKeys, type OcrJobRequest } from '../shared/ocr-job';
import { buildPrompt, normalizeDraft, summarizeDraft, toOcrImage, type Draft } from './draft';
import { readReceipt, type OcrImage } from './llm';

export { normalizeDraft, sniffMediaType, summarizeDraft } from './draft';

const RECEIPT_BUCKET = requireEnv('RECEIPT_BUCKET');
const TABLE_NAME = requireEnv('TABLE_NAME');

const s3 = new S3Client({});
const documents = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/**
 * api の Lambda から非同期で呼ばれ、読み取った結果をジョブの行に書き込む（shared/ocr-job.ts）。
 * 画面へは直接返さない。画面は GET /receipts/analyze/{jobId} で結果を聞きに来る。
 *
 * 失敗は握ってジョブに書き、関数としては正常に終える。投げると Lambda の非同期呼び出しが
 * 同じ画像で読み直し、モデルの課金が重なるため（api-stack でも再試行を 0 にしてある）。
 */
export async function handler(event: Partial<OcrJobRequest>): Promise<void> {
  const { jobId, sub, keys } = event;
  if (typeof jobId !== 'string' || typeof sub !== 'string' || sub === '' || !Array.isArray(keys)) {
    // api が組み立てた本文以外では呼ばれない。書き込む先も分からないので、ログだけ残す
    console.error('[ocr] failed', { reason: 'ジョブの本文が足りない', jobId });
    return;
  }

  // api でも確かめているが、他人の画像を読む経路は二重に塞いでおく
  const parsed = parseKeys({ keys }, sub);
  if ('error' in parsed) {
    if (parsed.status === 403) console.warn('[ocr] key does not belong to caller', { sub, keys: parsed.keys });
    await finish(sub, jobId, { status: 'failed', message: parsed.error });
    return;
  }

  try {
    const images = await Promise.all(parsed.keys.map(loadImage));
    const draft = await analyze(images);
    // 画面はこの後、覚えていない品目だけを判定（classify）に回す。[classify] 判定 の件数と
    // 突き合わせると、覚えたカテゴリで決まった品目の数が分かる
    console.info('[ocr] draft', JSON.stringify(summarizeDraft(draft)));
    await finish(sub, jobId, { status: 'done', draft });
  } catch (cause) {
    console.error('[ocr] failed', cause);
    const message = cause instanceof Error ? cause.message : 'レシートの読み取りに失敗しました';
    await finish(sub, jobId, { status: 'failed', message });
  }
}

/** ジョブの行に結果を書く。行は api が作ったものだけを更新し、無ければ作らない */
async function finish(
  sub: string,
  jobId: string,
  result: { status: 'done'; draft: Draft } | { status: 'failed'; message: string },
): Promise<void> {
  const values: Record<string, unknown> = { ':status': result.status, ':finishedAt': new Date().toISOString() };
  let expression = 'SET #status = :status, finishedAt = :finishedAt';
  if (result.status === 'done') {
    expression += ', draft = :draft';
    values[':draft'] = result.draft;
  } else {
    expression += ', message = :message';
    values[':message'] = result.message;
  }

  await documents.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: ocrJobKey(sub, jobId),
      UpdateExpression: expression,
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: values,
    }),
  );
}

async function loadImage(key: string): Promise<OcrImage> {
  const object = await s3.send(new GetObjectCommand({ Bucket: RECEIPT_BUCKET, Key: key }));
  if (!object.Body) throw new Error('画像が見つかりません');

  return toOcrImage(await object.Body.transformToByteArray());
}

/**
 * 写真を読ませて下書きにする。呼び先（Claude API か Bedrock か）と読み直しは llm.ts が決める。
 */
async function analyze(images: OcrImage[]): Promise<Draft> {
  const { text } = await readReceipt(images, buildPrompt(images.length));
  return normalizeDraft(text);
}
