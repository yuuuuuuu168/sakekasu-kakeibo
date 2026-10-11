import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APIConnectionError, APIConnectionTimeoutError, APIError } from '@anthropic-ai/sdk/core/error';

/*
 * Claude API の SDK は呼び出し（messages.create）とトークンの交換だけ差し替え、
 * 失敗の型（AuthenticationError など。core/error）は本物を使う。読み直す条件は型で見分けているため。
 */
const anthropicCreate = vi.fn();
const federationConfigs: Record<string, unknown>[] = [];
const stsInputs: Record<string, unknown>[] = [];
const bedrockBodies: Record<string, unknown>[] = [];
let bedrockText = '{"storeName":"Bedrock"}';

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: anthropicCreate };
  },
}));

vi.mock('@anthropic-ai/sdk/lib/credentials/oidc-federation', () => ({
  oidcFederationProvider: (config: Record<string, unknown>) => {
    federationConfigs.push(config);
    return async () => ({ token: 'sk-ant-oat01-test', expiresAt: null });
  },
}));

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class {
    async send(command: { input: Record<string, unknown> }) {
      stsInputs.push(command.input);
      return { WebIdentityToken: 'aws-signed-jwt' };
    }
  },
  GetWebIdentityTokenCommand: class {
    constructor(readonly input: Record<string, unknown>) {}
  },
}));

vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: class {
    async send(command: { input: { body: string } }) {
      bedrockBodies.push(JSON.parse(command.input.body));
      return {
        body: new TextEncoder().encode(
          JSON.stringify({ content: [{ text: bedrockText }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } }),
        ),
      };
    }
  },
  InvokeModelCommand: class {
    constructor(readonly input: Record<string, unknown>) {}
  },
}));

const FEDERATION_ENV = {
  BEDROCK_MODEL_ID: 'jp.anthropic.claude-sonnet-4-6',
  LLM_PROVIDER: 'anthropic',
  ANTHROPIC_MODEL_OCR: 'claude-sonnet-5-5',
  ANTHROPIC_FEDERATION_RULE_ID: 'fdrl_test',
  ANTHROPIC_ORGANIZATION_ID: '00000000-0000-0000-0000-000000000000',
  ANTHROPIC_SERVICE_ACCOUNT_ID: 'svac_test',
  ANTHROPIC_WORKSPACE_ID: 'wrkspc_test',
};

const IMAGES = [{ base64: 'aGVsbG8=', mediaType: 'image/jpeg' }];

function message(text: string, stopReason = 'end_turn') {
  return {
    content: [{ type: 'text', text }],
    stop_reason: stopReason,
    usage: { input_tokens: 1500, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  };
}

function apiError(status: number, text = 'error') {
  return APIError.generate(status, { type: 'error', error: { type: 'x', message: text } }, undefined, new Headers());
}

/** 環境変数を置いてから読み込む。呼び先はモジュールの読み込み時に決まる */
async function load(env: Record<string, string>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  return import('../llm');
}

let warnings: string[];
let infos: string[];

beforeEach(() => {
  anthropicCreate.mockReset();
  federationConfigs.length = 0;
  stsInputs.length = 0;
  bedrockBodies.length = 0;
  bedrockText = '{"storeName":"Bedrock"}';
  warnings = [];
  infos = [];
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => void warnings.push(args.join(' ')));
  vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => void infos.push(args.join(' ')));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('readConfig（呼び先の決め方）', () => {
  it('ID 連携の値が揃っていれば Claude API', async () => {
    const { readConfig } = await load(FEDERATION_ENV);
    expect(readConfig(FEDERATION_ENV)).toMatchObject({ provider: 'anthropic', anthropicModel: 'claude-sonnet-5-5' });
  });

  it('LLM_PROVIDER が anthropic でも、ID 連携の値が欠けていれば Bedrock だけで読む', async () => {
    const { readConfig } = await load(FEDERATION_ENV);
    const env = { ...FEDERATION_ENV, ANTHROPIC_FEDERATION_RULE_ID: '' };
    expect(readConfig(env)).toMatchObject({ provider: 'bedrock' });
  });

  it('LLM_PROVIDER が bedrock なら Bedrock', async () => {
    const { readConfig } = await load(FEDERATION_ENV);
    expect(readConfig({ ...FEDERATION_ENV, LLM_PROVIDER: 'bedrock' })).toMatchObject({ provider: 'bedrock' });
  });

  it('Bedrock のモデルが無ければ落とす（控えが無いまま動かさない）', async () => {
    const { readConfig } = await load(FEDERATION_ENV);
    expect(() => readConfig({ ...FEDERATION_ENV, BEDROCK_MODEL_ID: '' })).toThrow('BEDROCK_MODEL_ID');
  });
});

describe('fallbackReason（Bedrock で読み直す失敗）', () => {
  it.each([
    [401, 'authentication'],
    [403, 'permission'],
    [429, 'rate_limit'],
    [500, 'server_error'],
    [529, 'overloaded'],
  ])('%i は読み直す（%s）', async (status, reason) => {
    const { fallbackReason } = await load(FEDERATION_ENV);
    expect(fallbackReason(apiError(status))).toBe(reason);
  });

  it('残高不足（400 の文言）は読み直す', async () => {
    const { fallbackReason } = await load(FEDERATION_ENV);
    const error = apiError(400, 'Your credit balance is too low to access the Anthropic API.');
    expect(fallbackReason(error)).toBe('credit_balance');
  });

  it('それ以外の 400 は頼み方の誤りなので読み直さない', async () => {
    const { fallbackReason } = await load(FEDERATION_ENV);
    expect(fallbackReason(apiError(400, 'messages: image too large'))).toBeUndefined();
  });

  it('通信の失敗と時間切れは読み直す', async () => {
    const { fallbackReason } = await load(FEDERATION_ENV);
    expect(fallbackReason(new APIConnectionTimeoutError())).toBe('timeout');
    expect(fallbackReason(new APIConnectionError({ message: 'socket hang up' }))).toBe('connection');
  });

  it('API の失敗でないもの（STS やトークンの交換の失敗）は読み直す', async () => {
    const { fallbackReason } = await load(FEDERATION_ENV);
    expect(fallbackReason(new Error('OutboundWebIdentityFederationDisabledException'))).toBe('credentials');
  });
});

describe('readReceipt', () => {
  it('Claude API で読み、消費を 1 行の JSON で残す', async () => {
    const { readReceipt } = await load(FEDERATION_ENV);
    anthropicCreate.mockResolvedValue(message('{"storeName":"Claude"}'));

    await expect(readReceipt(IMAGES, '読んで')).resolves.toEqual({
      text: '{"storeName":"Claude"}',
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
    });

    const [params] = anthropicCreate.mock.calls[0]!;
    expect(params).toMatchObject({ model: 'claude-sonnet-5-5', output_config: { effort: 'low' } });
    expect(params.temperature).toBeUndefined();
    expect(params.messages[0].content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'aGVsbG8=' } },
      { type: 'text', text: '読んで' },
    ]);
    expect(bedrockBodies).toEqual([]);

    const usage = infos.find((line) => line.startsWith('[ocr] llm'));
    expect(JSON.parse(usage!.replace('[ocr] llm ', ''))).toMatchObject({
      provider: 'anthropic',
      photos: 1,
      usage: { input: 1500, output: 300, cacheRead: 0, cacheWrite: 0 },
    });
  });

  it('ID 連携は ルール・組織・サービスアカウントで交換し、JWT は Anthropic 宛てで頼む', async () => {
    await load(FEDERATION_ENV);
    expect(federationConfigs).toHaveLength(1);
    const config = federationConfigs[0]!;
    expect(config).toMatchObject({
      federationRuleId: 'fdrl_test',
      organizationId: '00000000-0000-0000-0000-000000000000',
      serviceAccountId: 'svac_test',
      workspaceId: 'wrkspc_test',
      baseURL: 'https://api.anthropic.com',
    });

    await expect((config.identityTokenProvider as () => Promise<string>)()).resolves.toBe('aws-signed-jwt');
    expect(stsInputs).toEqual([{ Audience: ['https://api.anthropic.com'], SigningAlgorithm: 'RS256', DurationSeconds: 300 }]);
  });

  it('残高不足なら Bedrock で読み直し、fallback=true を JSON でログに出す', async () => {
    const { readReceipt } = await load(FEDERATION_ENV);
    anthropicCreate.mockRejectedValue(apiError(400, 'Your credit balance is too low to access the Anthropic API.'));

    await expect(readReceipt(IMAGES, '読んで')).resolves.toMatchObject({ provider: 'bedrock', text: '{"storeName":"Bedrock"}' });

    const line = warnings.find((entry) => entry.startsWith('[ocr] fallback'));
    expect(JSON.parse(line!.replace('[ocr] fallback ', ''))).toMatchObject({
      fallback: true,
      from: 'anthropic',
      to: 'bedrock',
      errorType: 'credit_balance',
      status: 400,
    });
    // Bedrock にも同じ画像と指示文を渡す
    expect(bedrockBodies[0]).toMatchObject({
      anthropic_version: 'bedrock-2023-05-31',
      messages: [{ role: 'user', content: [{ type: 'image' }, { type: 'text', text: '読んで' }] }],
    });
  });

  it('モデルが断ったら Bedrock で読み直す', async () => {
    const { readReceipt } = await load(FEDERATION_ENV);
    anthropicCreate.mockResolvedValue(message('', 'refusal'));
    await expect(readReceipt(IMAGES, '読んで')).resolves.toMatchObject({ provider: 'bedrock' });
    expect(warnings.some((entry) => entry.includes('"errorType":"refusal"'))).toBe(true);
  });

  it('頼み方の誤り（400）は読み直さずに投げる', async () => {
    const { readReceipt } = await load(FEDERATION_ENV);
    anthropicCreate.mockRejectedValue(apiError(400, 'messages: image too large'));
    await expect(readReceipt(IMAGES, '読んで')).rejects.toThrow('image too large');
    expect(bedrockBodies).toEqual([]);
  });

  it('ID 連携の値が無ければ、Claude API を作らずに Bedrock で読む', async () => {
    const { readReceipt } = await load({ BEDROCK_MODEL_ID: 'jp.anthropic.claude-sonnet-4-6', LLM_PROVIDER: 'anthropic' });
    await expect(readReceipt(IMAGES, '読んで')).resolves.toMatchObject({ provider: 'bedrock' });
    expect(federationConfigs).toEqual([]);
    expect(anthropicCreate).not.toHaveBeenCalled();
    expect(warnings).toEqual([]);
  });
});
