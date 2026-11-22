import { createHmac, timingSafeEqual } from 'node:crypto';

/*
 * 下書き登録 API の署名の検証。AWS にも環境変数にも触らない純粋な処理。
 *
 * 呼び手（Muse）は秘密の鍵を送らず、本文と送信時刻に対する HMAC-SHA256 だけを送る。
 * 途中で盗み見られても鍵は漏れず、本文を書き換えれば署名が合わなくなり、
 * 時刻を入れてあるので、5 分を過ぎた送り直しは弾ける。
 *
 *   署名する文字列 = "<X-Kakeibo-Timestamp>.<本文のバイト列そのまま>"
 *   X-Kakeibo-Signature = HEX( HMAC-SHA256(鍵, 署名する文字列) )
 *
 * 5 分の内側の送り直しは通るが、同じ本文なら同じ注文番号・Message-ID なので、
 * 冪等性の判定で既存の下書きが返るだけになる。
 */

/** 送信時刻とサーバーの時刻のずれの許容（秒） */
export const MAX_CLOCK_SKEW_SECONDS = 300;
/** 鍵の期限がこの日数を切ったら、呼ばれるたびに警告の行を出す（アラームが拾って Slack に出す） */
export const KEY_EXPIRY_WARNING_DAYS = 14;
/** 鍵の短さの下限。発行スクリプトは 64 文字（32 バイトの 16 進）で作る */
const MIN_SECRET_LENGTH = 32;

/**
 * Secrets Manager に入れる鍵の 1 件。シークレットの中身は `{ "keys": [InboxKey, ...] }`。
 * 失効は、この一覧から消すだけ（呼ばれるたびに読み直すので、すぐ効く）。
 * 差し替えの間は新旧を並べておける
 */
export type InboxKey = {
  /** X-Kakeibo-Key-Id で送られてくる名前。秘密ではない */
  id: string;
  /** HMAC の鍵 */
  secret: string;
  /** この鍵で置いた下書きを入れる利用者（共通のユーザープールの sub） */
  sub: string;
  /** 有効期限（ISO 8601）。過ぎたら 401 */
  expiresAt: string;
};

/** シークレットの中身を読む。形の合わない鍵は捨てる（全部捨てれば、どの呼び出しも 401 になる） */
export function parseKeys(text: string | undefined): InboxKey[] {
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const keys = (parsed as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys)) return [];
  return keys.filter(
    (key): key is InboxKey =>
      typeof key === 'object' &&
      key !== null &&
      typeof key.id === 'string' &&
      key.id !== '' &&
      typeof key.secret === 'string' &&
      key.secret.length >= MIN_SECRET_LENGTH &&
      typeof key.sub === 'string' &&
      key.sub !== '' &&
      typeof key.expiresAt === 'string' &&
      !Number.isNaN(Date.parse(key.expiresAt)),
  );
}

/** 署名を作る。検証と、発行したときの手元での確かめに使う */
export function sign(secret: string, timestamp: string, body: Buffer): string {
  return createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex');
}

export type AuthResult =
  | { ok: true; key: InboxKey }
  | {
      ok: false;
      /** ログに出す理由。呼び手には返さない（どこで落ちたかを教えると、総当たりの手がかりになる） */
      reason: string;
    };

export function verifyRequest(input: {
  keyId: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
  body: Buffer;
  keys: InboxKey[];
  now: Date;
}): AuthResult {
  const { keyId, timestamp, signature, body, keys, now } = input;
  if (!keyId || !timestamp || !signature) return { ok: false, reason: '署名のヘッダが足りない' };
  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: '送信時刻が UNIX 秒ではない' };
  if (!/^[0-9a-fA-F]{64}$/.test(signature)) return { ok: false, reason: '署名が 64 桁の 16 進ではない' };

  const skew = Math.abs(now.getTime() / 1000 - Number(timestamp));
  if (skew > MAX_CLOCK_SKEW_SECONDS) return { ok: false, reason: `送信時刻が ${Math.round(skew)} 秒ずれている` };

  const key = keys.find((candidate) => candidate.id === keyId);
  if (!key) return { ok: false, reason: '鍵の ID が見つからない（失効済みを含む）' };
  if (Date.parse(key.expiresAt) <= now.getTime()) return { ok: false, reason: '鍵の期限が切れている' };

  const expected = Buffer.from(sign(key.secret, timestamp, body), 'hex');
  const actual = Buffer.from(signature, 'hex');
  // 長さは上の正規表現で 32 バイトに揃っている。比べる時間で一致した桁数が漏れないよう定数時間で比べる
  if (!timingSafeEqual(expected, actual)) return { ok: false, reason: '署名が合わない' };
  return { ok: true, key };
}

/** 鍵の期限までの日数（切り捨て） */
export function daysLeft(key: InboxKey, now: Date): number {
  return Math.floor((Date.parse(key.expiresAt) - now.getTime()) / 86_400_000);
}
