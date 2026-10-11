/**
 * STS に頼む ID トークン（JWT）の宛先と寿命。OCR の Lambda（llm.ts）と、その権限を組む
 * CDK（lib/api-stack.ts の sts:GetWebIdentityToken の条件）の両方が読む。
 *
 * 宛先は Claude Console のフェデレーションルールの audience とも合わせてある。
 * Anthropic のトークンの寿命は「ルールの寿命（600 秒）」と「JWT の残り × 2」の短い方になる。
 */
export const IDENTITY_TOKEN_AUDIENCE = 'https://api.anthropic.com';
export const IDENTITY_TOKEN_SECONDS = 300;

/**
 * OCR の既定の呼び先（Claude API）のモデル。CDK が環境変数 ANTHROPIC_MODEL_OCR に入れ、
 * llm.ts は環境変数が無いときの既定にも使う。精度が足りなければ claude-opus-5-5 に上げる。
 */
export const DEFAULT_ANTHROPIC_MODEL_OCR = 'claude-sonnet-5-5';
