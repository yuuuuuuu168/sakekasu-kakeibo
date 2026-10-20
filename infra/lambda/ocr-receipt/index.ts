import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { normalizeDraft, summarizeDraft, type NormalizedDraft } from '@kakeibo/core';
import { ocrJobKey, parseKeys, type OcrJobRequest } from '../shared/ocr-job';
import { readReceipt, type OcrImage } from './llm';

const RECEIPT_BUCKET = requireEnv('RECEIPT_BUCKET');
const TABLE_NAME = requireEnv('TABLE_NAME');
/** モデルが受け取れる画像の上限（Claude API も Bedrock も 1 枚 5MB）。base64 にした後の長さで判定される */
const BASE64_LIMIT = 5 * 1024 * 1024;

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
  result: { status: 'done'; draft: NormalizedDraft } | { status: 'failed'; message: string },
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

/**
 * 写真を読ませて下書きにする。呼び先（Claude API か Bedrock か）と読み直しは llm.ts が決める。
 * モデルの出力を下書きに直す normalizeDraft は core（receipt/draft.ts）にある。
 */
async function analyze(images: OcrImage[]): Promise<NormalizedDraft> {
  const { text } = await readReceipt(images, buildPrompt(images.length));
  return normalizeDraft(text);
}
