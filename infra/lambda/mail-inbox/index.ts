import { randomBytes } from 'node:crypto';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { requireEnv } from '../shared/env';
import { json } from '../shared/http';
import { parseMailDraft, receiptFromDraft, findExisting } from './draft';
import { judgeItems } from './judge';
import { KEY_EXPIRY_WARNING_DAYS, daysLeft, parseKeys, verifyRequest, type InboxKey } from './signature';
import { countCall, createReceipt, findMarkedReceiptId, loadContext } from './store';

/*
 * 下書き登録 API（POST /draft-entries）。通販のメールを読んだ Muse が、レシートの下書きを 1 件置く。
 * 取り決めは docs/mail-inbox.md にある。
 *
 * この経路だけは共通のユーザープールの JWT を通らない（Muse はブラウザでログインできない）。
 * 代わりに、鍵を共有した HMAC-SHA256 の署名で呼び手を確かめる（signature.ts）。
 * この鍵でできるのはレシートを 1 枚足すことだけで、読み出しも更新も削除もできない。
 *
 * 順番は 認証 → 1 日の件数 → 本文の検査 → 既存の判定 → カテゴリ判定 → 保存。
 * 認証より前には何も読まず、何も書かない。
 */

const SECRET_ID = requireEnv('MAIL_INBOX_SECRET_ID');
const secrets = new SecretsManagerClient({});

/** 本文の大きさの上限。品目 50 行でも数 KB に収まる */
const MAX_BODY_BYTES = 64 * 1024;

type Outcome = '作成' | '既存' | '認証失敗' | '検証エラー' | '上限超過' | '失敗';

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const started = Date.now();
  const log: Record<string, unknown> = {};
  let outcome: Outcome = '失敗';

  const result = await (async () => {
    try {
      const run = await accept(event, log);
      outcome = run.outcome;
      return run.response;
    } catch (cause) {
      console.error('[mail-inbox] failed', cause);
      return json(500, { error: 'internal_error', message: '処理に失敗しました。時間をおいて送り直してください' });
    }
  })();

  // 1 回の呼び出しにつき 1 行。鍵と署名は出さない。店名・品目名・金額は出す（利用者が出してよいと決めた）
  console.info(
    '[mail-inbox]',
    JSON.stringify({
      結果: outcome,
      状態: typeof result === 'object' ? result.statusCode : undefined,
      所要ms: Date.now() - started,
      ...log,
    }),
  );
  return result;
}

async function accept(
  event: APIGatewayProxyEventV2,
  log: Record<string, unknown>,
): Promise<{ outcome: Outcome; response: APIGatewayProxyResultV2 }> {
  const now = new Date();
  const body = Buffer.from(event.body ?? '', event.isBase64Encoded ? 'base64' : 'utf-8');
  const headers = event.headers ?? {};

  // --- 認証 ---
  const keyId = headers['x-kakeibo-key-id'];
  if (keyId) log.鍵 = keyId.slice(0, 64);
  const auth = verifyRequest({
    keyId,
    timestamp: headers['x-kakeibo-timestamp'],
    signature: headers['x-kakeibo-signature'],
    body,
    keys: await loadKeys(),
    now,
  });
  if (!auth.ok) {
    log.理由 = auth.reason;
    // アラーム（mail-inbox-auth-failures）はこの文言を数える。infra/lib/api-alarms.ts と合わせる
    console.warn('[mail-inbox] auth-failed');
    return { outcome: '認証失敗', response: json(401, { error: 'unauthorized', message: '認証に失敗しました' }) };
  }
  warnIfExpiring(auth.key, now);
  const sub = auth.key.sub;

  // --- 1 日の件数 ---
  if (!(await countCall(sub, now))) {
    return {
      outcome: '上限超過',
      response: json(429, { error: 'rate_limited', message: '今日の受付の上限に達しました。明日以降に送り直してください' }),
    };
  }

  // --- 本文 ---
  if (body.length > MAX_BODY_BYTES) {
    return { outcome: '検証エラー', response: validationError([{ field: 'body', message: '本文が大きすぎます' }]) };
  }
  const parsed = parseMailDraft(parseJson(body));
  if (!parsed.ok) {
    log.理由 = parsed.details;
    return { outcome: '検証エラー', response: validationError(parsed.details) };
  }
  const draft = parsed.draft;
  Object.assign(log, {
    店: draft.store,
    日付: draft.date,
    金額: draft.amount,
    品目: draft.items.map((item) => `${item.name} ${item.amount}`),
    ...(draft.orderNumber ? { 注文番号: draft.orderNumber } : {}),
  });

  // --- 既存の判定 ---
  const context = await loadContext(sub);
  const existingId = findExisting(context.receipts, draft)?.id ?? (await findMarkedReceiptId(sub, draft.orderNumber, draft.messageId));
  if (existingId) {
    log.id = existingId;
    return { outcome: '既存', response: json(200, { id: existingId, status: 'draft' }) };
  }

  // --- 組み立てと保存 ---
  const id = `r-${now.getTime().toString(36)}${randomBytes(3).toString('hex')}`;
  const receipt = receiptFromDraft(draft, id, now);
  receipt.items = await judgeItems(receipt.items, receipt.storeName, context.categories, context.rules, sub);
  log.カテゴリ = receipt.items.map((item) => item.categoryId);

  const saved = await createReceipt(sub, receipt);
  if (!saved.created) {
    // 同じ注文の別のメールが、ほぼ同時に先に通った
    log.id = saved.existingId;
    if (!saved.existingId) throw new Error('marker exists without receipt id');
    return { outcome: '既存', response: json(200, { id: saved.existingId, status: 'draft' }) };
  }
  log.id = id;
  return { outcome: '作成', response: json(201, { id, status: 'draft' }) };
}

/** 鍵は呼ばれるたびに読み直す。失効（一覧から消す）をすぐ効かせるため。呼び出しは 1 日 20 件までなので費用は無視できる */
async function loadKeys(): Promise<InboxKey[]> {
  try {
    const secret = await secrets.send(new GetSecretValueCommand({ SecretId: SECRET_ID }));
    return parseKeys(secret.SecretString);
  } catch (cause) {
    // 例外にはシークレットの ARN が載るので、名前だけ出す。鍵が読めなければ全部 401 になり、アラームが拾う
    console.error('[mail-inbox] keys unavailable', cause instanceof Error ? cause.name : 'unknown');
    return [];
  }
}

function warnIfExpiring(key: InboxKey, now: Date): void {
  const left = daysLeft(key, now);
  if (left < KEY_EXPIRY_WARNING_DAYS) {
    // アラーム（mail-inbox-key-expiring）はこの文言を数える。infra/lib/api-alarms.ts と合わせる
    console.warn('[mail-inbox] key-expiring', JSON.stringify({ 鍵: key.id, 残り日数: left }));
  }
}

function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf-8'));
  } catch {
    return undefined;
  }
}

function validationError(details: { field: string; message: string }[]): APIGatewayProxyResultV2 {
  return json(422, { error: 'validation_error', details });
}
