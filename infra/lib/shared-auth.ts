/**
 * 4 アプリ共通のログイン（sakekasu-integrated_environment の identity スタック）の値。
 *
 * どれも秘密ではない（ブラウザに配る値）。スタックの間を参照でつながないため、
 * `cdk.json` の context `sharedAuth` に書いて渡す。共通基盤の側で値が変わったら
 * ここも書き換える（共通基盤の docs/identity.md の「デプロイ済みの値」が正）。
 */
export interface SharedAuth {
  /** マネージドログインのドメイン（https:// を付けない。例: auth.sakekasu-builder.com） */
  domain: string;
  /** 共通ユーザープールの ID（例: ap-northeast-1_xxxxxxxxx） */
  userPoolId: string;
  /** kakeibo 用のアプリクライアント ID */
  clientId: string;
}

const DOMAIN = /^[a-z0-9.-]+\.[a-z]{2,}$/;
const USER_POOL_ID = /^[a-z]{2}-[a-z]+-\d_[A-Za-z0-9]+$/;
const CLIENT_ID = /^[a-z0-9]+$/;

/**
 * context の値を確かめて SharedAuth に直す。
 *
 * 無いときも形が違うときも落とす。空の値で API の JWT 検証を作ったり、
 * 画面をローカルモードに落としたりするのを避けるため。
 */
export function parseSharedAuth(value: unknown): SharedAuth {
  if (typeof value !== 'object' || value === null) {
    throw new Error('context の sharedAuth が要る（{ "domain", "userPoolId", "clientId" }。infra/cdk.json に書く）');
  }
  const { domain, userPoolId, clientId } = value as Record<string, unknown>;
  if (typeof domain !== 'string' || !DOMAIN.test(domain)) {
    throw new Error(`sharedAuth.domain が不正です（https:// を付けないホスト名で書く）: ${String(domain)}`);
  }
  if (typeof userPoolId !== 'string' || !USER_POOL_ID.test(userPoolId)) {
    throw new Error(`sharedAuth.userPoolId が不正です: ${String(userPoolId)}`);
  }
  if (typeof clientId !== 'string' || !CLIENT_ID.test(clientId)) {
    throw new Error(`sharedAuth.clientId が不正です: ${String(clientId)}`);
  }
  return { domain, userPoolId, clientId };
}

/** ユーザープールのリージョン。ID の `_` より前がそのまま入っている */
export function userPoolRegion(userPoolId: string): string {
  return userPoolId.split('_')[0]!;
}
