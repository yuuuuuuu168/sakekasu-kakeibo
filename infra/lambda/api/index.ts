import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { MAX_TRANSACTIONS_PER_REQUEST } from '@kakeibo/core';
import { json, parseBody, subOf, type Json } from '../shared/http';
import { SK } from '../shared/snapshot-items';
import { describeRequest } from './log';
import { createUpload, getOcrJob, startOcrJob } from './ocr';
import { matchRoute, type Route } from './routes';
import { getReport, loadSnapshot, put, putTransactionRows, remove } from './store';
import { BadRequest, assertLimits, assertMapping, assertMonth, assertReceipt, assertTransaction, decodeSegment } from './validate';

/*
 * 画面から呼ばれる API。認証（共通のユーザープールの JWT）は API Gateway が済ませ、ここは sub だけを見る。
 *
 * ここに置くのはルート表と、呼び出しごとの後始末（400 と 500 への変換、1 行のログ）だけ。
 * 検証は validate.ts、DynamoDB は store.ts、画像と読み取りのジョブは ocr.ts、ログの中身は log.ts にある。
 */

type Handler = (request: { sub: string; params: Record<string, string>; body: Json }) => Promise<APIGatewayProxyResultV2>;

const noContent = () => json(204, undefined);

const ROUTES: Route<Handler>[] = [
  { method: 'GET', path: '/snapshot', handle: async ({ sub }) => json(200, await loadSnapshot(sub)) },

  { method: 'PUT', path: '/transactions', handle: ({ sub, body }) => putTransactions(sub, body) },
  {
    method: 'PUT',
    path: '/transactions/:id',
    handle: async ({ sub, params, body }) => {
      await put(sub, SK.transaction(params.id), assertTransaction({ ...body, id: params.id }));
      return noContent();
    },
  },
  {
    method: 'DELETE',
    path: '/transactions/:id',
    handle: async ({ sub, params }) => {
      await remove(sub, SK.transaction(params.id));
      return noContent();
    },
  },

  { method: 'PUT', path: '/categories', handle: ({ sub, body }) => putConfig(sub, SK.categories, 'categories', body) },
  { method: 'PUT', path: '/rules', handle: ({ sub, body }) => putConfig(sub, SK.rules, 'rules', body) },
  { method: 'PUT', path: '/recurring', handle: ({ sub, body }) => putConfig(sub, SK.recurring, 'recurring', body) },

  {
    method: 'PUT',
    path: '/budgets/:month',
    handle: async ({ sub, params, body }) => {
      assertMonth(params.month);
      await put(sub, SK.budget(params.month), { month: params.month, limits: assertLimits(body.limits) });
      return noContent();
    },
  },

  {
    method: 'PUT',
    path: '/mappings/:sourceId',
    handle: async ({ sub, params, body }) => {
      await put(sub, SK.mapping(params.sourceId), assertMapping(body, params.sourceId));
      return noContent();
    },
  },

  // 読み取りのジョブは /receipts/:id より先に置く
  { method: 'POST', path: '/receipts/analyze', handle: ({ sub, body }) => startOcrJob(sub, body) },
  { method: 'GET', path: '/receipts/analyze/:jobId', handle: ({ sub, params }) => getOcrJob(sub, params.jobId) },
  {
    method: 'PUT',
    path: '/receipts/:id',
    handle: async ({ sub, params, body }) => {
      await put(sub, SK.receipt(params.id), assertReceipt(body, params.id, sub));
      return noContent();
    },
  },
  {
    method: 'DELETE',
    path: '/receipts/:id',
    handle: async ({ sub, params }) => {
      await remove(sub, SK.receipt(params.id));
      return noContent();
    },
  },

  { method: 'POST', path: '/uploads', handle: ({ sub, body }) => createUpload(sub, body) },

  {
    method: 'GET',
    path: '/reports/:month',
    handle: async ({ sub, params }) => {
      assertMonth(params.month);
      const report = await getReport(sub, params.month);
      if (report === undefined) return json(404, { message: 'この月のレポートはまだありません' });
      return json(200, report);
    },
  },
];

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> {
  const sub = subOf(event);
  if (!sub) return json(401, { message: 'サインインが必要です' });

  const method = event.requestContext.http.method;
  const segments = (event.rawPath ?? '').split('/').filter(Boolean).map(decodeSegment);
  const body = parseBody(event.body, event.isBase64Encoded);
  const started = Date.now();

  let reason: string | undefined;
  const result = await (async () => {
    try {
      const matched = matchRoute(ROUTES, method, segments);
      if (!matched) return json(404, { message: 'そのような操作はありません' });
      return await matched.route.handle({ sub, params: matched.params, body });
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

async function putTransactions(sub: string, body: Json): Promise<APIGatewayProxyResultV2> {
  const transactions = body.transactions;
  if (!Array.isArray(transactions)) throw new BadRequest('transactions が要ります');
  if (transactions.length === 0) return noContent();
  if (transactions.length > MAX_TRANSACTIONS_PER_REQUEST) {
    throw new BadRequest(`一度に送れる明細は ${MAX_TRANSACTIONS_PER_REQUEST} 件までです`);
  }
  await putTransactionRows(sub, transactions.map((txn) => assertTransaction(txn)));
  return noContent();
}

async function putConfig(sub: string, sk: string, field: string, body: Json): Promise<APIGatewayProxyResultV2> {
  const value = body[field];
  if (!Array.isArray(value)) throw new BadRequest(`${field} が要ります`);
  await put(sub, sk, { [field]: value });
  return noContent();
}
