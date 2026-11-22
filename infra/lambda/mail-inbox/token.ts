import { createHash, timingSafeEqual } from 'node:crypto';

/*
 * 下書き登録 API のトークンの検証。AWS にも環境変数にも触らない純粋な処理。
 *
 * 呼び手（Muse）は `Authorization: Bearer <トークン>` を送る。こちらはトークンそのものを持たず、
 * SHA-256 のハッシュだけを Secrets Manager に置く。シークレットを読まれても、そこからトークンは作れない。
 * トークンは 32 バイトの乱数なので、遅いハッシュ（bcrypt など）でなくても総当たりで戻せない。
 *
 * 署名方式（HMAC）から切り替えた。Muse の資格情報の仕組みに、秘密の値を持ったまま署名を作る経路が無かったため。
 * 送り直しと本文の改ざんは防げなくなったが、できるのはレシートを 1 日 20 枚まで足すことだけで、
 * 送り直しは冪等性の判定で既存の下書きが返るだけになる。
 */

/** 鍵の期限がこの日数を切ったら、呼ばれるたびに警告の行を出す（アラームが拾って Slack に出す） */
export const KEY_EXPIRY_WARNING_DAYS = 14;
/** トークンの頭。ログやエディタで見かけたときに、何の鍵か分かるようにする */
export const TOKEN_PREFIX = 'kkb_';

/**
 * Secrets Manager に入れる鍵の 1 件。シークレットの中身は `{ "keys": [InboxKey, ...] }`。
 * 失効は、この一覧から消すだけ（呼ばれるたびに読み直すので、すぐ効く）。差し替えの間は新旧を並べておける
 */
export type InboxKey = {
  /** 鍵の名前。ログに出す。秘密ではない */
  id: string;
  /** トークンの SHA-256（16 進 64 桁） */
  tokenHash: string;
  /** この鍵で置いた下書きを入れる利用者（共通のユーザープールの sub） */
  sub: string;
  /** 有効期限（ISO 8601）。過ぎたら 401 */
  expiresAt: string;
};

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf-8').digest('hex');
}

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
      typeof key.tokenHash === 'string' &&
      /^[0-9a-f]{64}$/.test(key.tokenHash) &&
      typeof key.sub === 'string' &&
      key.sub !== '' &&
      typeof key.expiresAt === 'string' &&
      !Number.isNaN(Date.parse(key.expiresAt)),
  );
}

export type AuthResult =
  | { ok: true; key: InboxKey }
  | {
      ok: false;
      /** ログに出す理由。呼び手には返さない（どこで落ちたかを教えると、総当たりの手がかりになる） */
      reason: string;
    };

export function verifyBearer(authorization: string | undefined, keys: InboxKey[], now: Date): AuthResult {
  if (!authorization) return { ok: false, reason: 'Authorization ヘッダが無い' };
  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  if (!match) return { ok: false, reason: 'Bearer の形ではない' };

  const presented = Buffer.from(hashToken(match[1]), 'hex');
  // どの鍵とも、長さの揃ったハッシュを定数時間で比べる。見つかった位置で比べるのをやめない
  let found: InboxKey | undefined;
  for (const key of keys) {
    if (timingSafeEqual(presented, Buffer.from(key.tokenHash, 'hex')) && !found) found = key;
  }
  if (!found) return { ok: false, reason: 'トークンが一致しない（失効済みを含む）' };
  if (Date.parse(found.expiresAt) <= now.getTime()) return { ok: false, reason: `鍵 ${found.id} の期限が切れている` };
  return { ok: true, key: found };
}

/** 鍵の期限までの日数（切り捨て） */
export function daysLeft(key: InboxKey, now: Date): number {
  return Math.floor((Date.parse(key.expiresAt) - now.getTime()) / 86_400_000);
}
