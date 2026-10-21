import type { APIGatewayProxyResultV2 } from 'aws-lambda';

/*
 * API Gateway（HTTP API）から呼ばれる Lambda に共通の、本文の読み書き。
 * api と classify で同じものを書き写していたのをここにまとめる。
 */

export type Json = Record<string, unknown>;

/**
 * 本文を JSON として読む。壊れた JSON やオブジェクト以外は空のオブジェクトにする。
 * 必須の欄の有無は、読んだ後でそれぞれの処理が確かめる（足りなければ 400 を返す）
 */
export function parseBody(body: string | undefined, isBase64Encoded: boolean | undefined): Json {
  if (!body) return {};
  const text = isBase64Encoded ? Buffer.from(body, 'base64').toString('utf-8') : body;
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Json) : {};
  } catch {
    return {};
  }
}

/** JSON の応答。payload が undefined なら本文を空にする（204 など） */
export function json(statusCode: number, payload: unknown): APIGatewayProxyResultV2 {
  if (payload === undefined) return { statusCode, body: '' };
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload),
  };
}

/** JWT（共通のユーザープール）の sub。無ければ undefined で、呼び出し側は 401 を返す */
export function subOf(event: { requestContext: { authorizer?: { jwt?: { claims?: Record<string, unknown> } } } }): string | undefined {
  const sub = event.requestContext.authorizer?.jwt?.claims?.sub;
  return typeof sub === 'string' && sub !== '' ? sub : undefined;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
