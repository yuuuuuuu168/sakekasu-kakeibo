import Anthropic from '@anthropic-ai/sdk';
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  AuthenticationError,
  PermissionDeniedError,
  RateLimitError,
} from '@anthropic-ai/sdk/core/error';
import { oidcFederationProvider } from '@anthropic-ai/sdk/lib/credentials/oidc-federation';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { GetWebIdentityTokenCommand, STSClient } from '@aws-sdk/client-sts';
import { IDENTITY_TOKEN_AUDIENCE, IDENTITY_TOKEN_SECONDS } from './llm-constants';

/**
 * レシートを読むモデルの呼び出し。呼び先は 2 つで、どちらも同じ Messages API の形で頼む。
 *
 * - anthropic: Claude API（api.anthropic.com）。Max プランに付く月々のクレジットで払う。既定
 * - bedrock: Amazon Bedrock の Claude。クレジット切れや障害のときの控え。単純に課金される
 *
 * Claude API の認証は Workload Identity Federation で、API キーを持たない。この関数のロールで
 * STS の GetWebIdentityToken を呼んで AWS が署名した JWT をもらい、SDK が Anthropic の短命の
 * トークンと交換する（期限の前に自分でやり直す）。設定の手順は docs/operations.md にある。
 *
 * Claude API が次の理由で失敗したら、同じ頼みを Bedrock で読み直す（fallbackReason）。
 * 残高不足、認証・権限、流量の上限、過負荷・5xx（SDK の再試行の後も）、通信の失敗、
 * トークンの交換の失敗、モデルが断ったとき。それ以外の 4xx はこちらの頼み方の誤りなので、
 * 読み直さずに失敗にする（Bedrock でも同じく弾かれるだけで、誤りが見えなくなる）。
 */

export type OcrImage = { base64: string; mediaType: string };
export type Provider = 'anthropic' | 'bedrock';
export type ReadResult = { text: string; provider: Provider; model: string };

/**
 * 1 回の読み取りで出してよい長さ。印字の書き起こし（lines）を先に出させているので、
 * 分けて撮った長いレシート（最大 4 枚）だと 4,096 では足りなくなる。
 */
const MAX_TOKENS = 8192;

/**
 * Claude API の 1 回の待ち時間と再試行。SDK は 429・5xx・通信の失敗だけを再試行する。
 * 1 回の待ち時間は、長いレシートを 4 枚で読む場合（出力が長く、40 秒台になりうる）でも切らない長さにする。
 * 最悪でも 75 秒 × 2 回 + Bedrock の 60 秒が、OCR の Lambda のタイムアウト（api-stack の OCR_TIMEOUT_SECONDS = 240 秒）に
 * 収まるようにしてある。
 */
const ANTHROPIC_TIMEOUT_MS = 75_000;
const ANTHROPIC_MAX_RETRIES = 1;
const BEDROCK_TIMEOUT_MS = 60_000;


type Config = {
  provider: Provider;
  anthropicModel: string;
  bedrockModel: string;
  federation?: {
    ruleId: string;
    organizationId: string;
    serviceAccountId: string;
    workspaceId?: string;
  };
};

/**
 * 環境変数から呼び先を決める。LLM_PROVIDER が anthropic でも、ID 連携の値が揃っていなければ
 * Bedrock だけで読む（設定前の環境でも読み取りを止めない）。
 */
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const bedrockModel = env.BEDROCK_MODEL_ID;
  if (!bedrockModel) throw new Error('BEDROCK_MODEL_ID is not set');
  const anthropicModel = env.ANTHROPIC_MODEL_OCR || 'claude-sonnet-5-5';

  const ruleId = env.ANTHROPIC_FEDERATION_RULE_ID;
  const organizationId = env.ANTHROPIC_ORGANIZATION_ID;
  const serviceAccountId = env.ANTHROPIC_SERVICE_ACCOUNT_ID;
  const federation =
    ruleId && organizationId && serviceAccountId
      ? { ruleId, organizationId, serviceAccountId, workspaceId: env.ANTHROPIC_WORKSPACE_ID || undefined }
      : undefined;

  const wanted = env.LLM_PROVIDER === 'bedrock' ? 'bedrock' : 'anthropic';
  const provider = wanted === 'anthropic' && federation ? 'anthropic' : 'bedrock';
  return { provider, anthropicModel, bedrockModel, ...(federation ? { federation } : {}) };
}

/** モデルが断った（stop_reason が refusal）。Bedrock で読み直す */
class RefusalError extends Error {}

/**
 * Bedrock で読み直すべき失敗なら、その種類を返す。読み直さない失敗なら undefined。
 * 種類はログ（[ocr] fallback）にそのまま出し、CloudWatch で数える。
 */
export function fallbackReason(error: unknown): string | undefined {
  if (error instanceof RefusalError) return 'refusal';
  if (error instanceof APIConnectionTimeoutError) return 'timeout';
  if (error instanceof APIConnectionError) return 'connection';
  if (error instanceof AuthenticationError) return 'authentication';
  if (error instanceof PermissionDeniedError) return 'permission';
  if (error instanceof RateLimitError) return 'rate_limit';
  if (error instanceof APIError && typeof error.status === 'number') {
    if (error.status === 529) return 'overloaded';
    if (error.status >= 500) return 'server_error';
    // 残高不足は 400 で返り、本文の文言でしか見分けられない
    if (error.status === 400 && /credit balance is too low/i.test(error.message)) return 'credit_balance';
    return undefined;
  }
  // APIError でないもの: STS の失敗、トークンの交換の失敗など。読み取りの頼み方とは関係が無い
  return 'credentials';
}

/** 画像と指示文を Messages API の content にする。Claude API と Bedrock で共通 */
function buildContent(images: OcrImage[], prompt: string) {
  return [
    ...images.map((image) => ({
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: image.mediaType as 'image/jpeg' | 'image/png' | 'image/webp',
        data: image.base64,
      },
    })),
    { type: 'text' as const, text: prompt },
  ];
}

const config = readConfig();
const bedrock = new BedrockRuntimeClient({});
const anthropic = config.federation ? createAnthropicClient(config.federation) : undefined;

function createAnthropicClient(federation: NonNullable<Config['federation']>): Anthropic {
  // GetWebIdentityToken は地域ごとの STS にしかない。発行者 URL は global なので、どの地域で呼んでも同じ
  const sts = new STSClient({ region: process.env.AWS_REGION });
  return new Anthropic({
    // ログの水準は既定（warn）のまま。debug にすると本文とヘッダが CloudWatch に出る
    timeout: ANTHROPIC_TIMEOUT_MS,
    maxRetries: ANTHROPIC_MAX_RETRIES,
    credentials: oidcFederationProvider({
      // 交換のたびに新しい JWT を取る（jti は使い回すと弾かれる）
      identityTokenProvider: async () => {
        const out = await sts.send(
          new GetWebIdentityTokenCommand({
            Audience: [IDENTITY_TOKEN_AUDIENCE],
            SigningAlgorithm: 'RS256',
            DurationSeconds: IDENTITY_TOKEN_SECONDS,
          }),
        );
        if (!out.WebIdentityToken) throw new Error('STS が ID トークンを返しませんでした');
        return out.WebIdentityToken;
      },
      federationRuleId: federation.ruleId,
      organizationId: federation.organizationId,
      serviceAccountId: federation.serviceAccountId,
      workspaceId: federation.workspaceId,
      baseURL: 'https://api.anthropic.com',
      fetch,
    }),
  });
}

/**
 * レシートの写真を読ませて、モデルの返した文字列を返す。
 * Claude API が読み直すべき理由で失敗したら、Bedrock で読み直す。
 */
export async function readReceipt(images: OcrImage[], prompt: string): Promise<ReadResult> {
  const content = buildContent(images, prompt);
  if (config.provider === 'anthropic' && anthropic) {
    try {
      return await viaAnthropic(anthropic, content, images.length);
    } catch (error) {
      const reason = fallbackReason(error);
      if (!reason) throw error;
      console.warn(
        '[ocr] fallback',
        JSON.stringify({
          fallback: true,
          from: 'anthropic',
          to: 'bedrock',
          errorType: reason,
          status: error instanceof APIError ? error.status : undefined,
          message: error instanceof Error ? error.message.slice(0, 300) : String(error),
        }),
      );
    }
  }
  return viaBedrock(content, images.length);
}

async function viaAnthropic(client: Anthropic, content: ReturnType<typeof buildContent>, photos: number): Promise<ReadResult> {
  const started = Date.now();
  const message = await client.messages.create({
    model: config.anthropicModel,
    max_tokens: MAX_TOKENS,
    /*
     * 思考は止められない世代なので、effort を low にして浅く速くする。印字を読む仕事で、
     * 考え込む余地が少ない。temperature は今の世代では既定値以外を受け付けないので渡さない。
     * Sonnet 5.5 の between_tools は Opus に上げたときに弾かれるので使わない。
     */
    output_config: { effort: 'low' },
    messages: [{ role: 'user', content }],
  });
  logUsage({
    provider: 'anthropic',
    model: config.anthropicModel,
    photos,
    ms: Date.now() - started,
    stopReason: message.stop_reason,
    usage: {
      input: message.usage.input_tokens,
      output: message.usage.output_tokens,
      cacheRead: message.usage.cache_read_input_tokens ?? 0,
      cacheWrite: message.usage.cache_creation_input_tokens ?? 0,
    },
  });
  if (message.stop_reason === 'refusal') throw new RefusalError('モデルが読み取りを断りました');

  const text = message.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
  return { text, provider: 'anthropic', model: config.anthropicModel };
}

async function viaBedrock(content: ReturnType<typeof buildContent>, photos: number): Promise<ReadResult> {
  const started = Date.now();
  const response = await bedrock.send(
    new InvokeModelCommand({
      modelId: config.bedrockModel,
      contentType: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: MAX_TOKENS,
        temperature: 0,
        messages: [{ role: 'user', content }],
      }),
    }),
    { abortSignal: AbortSignal.timeout(BEDROCK_TIMEOUT_MS) },
  );

  const payload = JSON.parse(new TextDecoder().decode(response.body)) as {
    content?: { text?: string }[];
    stop_reason?: string;
    usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  };
  logUsage({
    provider: 'bedrock',
    model: config.bedrockModel,
    photos,
    ms: Date.now() - started,
    stopReason: payload.stop_reason ?? null,
    usage: {
      input: payload.usage?.input_tokens ?? 0,
      output: payload.usage?.output_tokens ?? 0,
      cacheRead: payload.usage?.cache_read_input_tokens ?? 0,
      cacheWrite: payload.usage?.cache_creation_input_tokens ?? 0,
    },
  });
  const text = payload.content?.map((part) => part.text ?? '').join('') ?? '';
  return { text, provider: 'bedrock', model: config.bedrockModel };
}

/**
 * 1 回の読み取りの消費。1 行の JSON にして、CloudWatch Logs Insights で
 * 呼び先ごとのトークン数や時間を集計できるようにする。画像や読んだ中身は出さない。
 */
function logUsage(entry: {
  provider: Provider;
  model: string;
  photos: number;
  ms: number;
  stopReason: string | null;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
}): void {
  console.info('[ocr] llm', JSON.stringify(entry));
}
