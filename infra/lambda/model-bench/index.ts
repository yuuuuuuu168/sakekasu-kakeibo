import type Anthropic from '@anthropic-ai/sdk';
import { APIError } from '@anthropic-ai/sdk/core/error';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, NoSuchKey, S3Client } from '@aws-sdk/client-s3';
import {
  SEED_CATEGORIES,
  applyItemRules,
  childChoiceSpecs,
  classifyItem,
  decideVerdicts,
  parentChoiceSpecs,
  withLaterSeeds,
  type Category,
  type CategoryRule,
  type ClassifyTarget,
  type Receipt,
  type Verdict,
} from '@kakeibo/core';
import { askClaude, type ClaudeEffort, type ClaudeUsage } from '../classify/claude';
import { ask, buildState, clientOnce } from '../classify/index';
import { buildPrompt, normalizeDraft, toOcrImage } from '../ocr-receipt/draft';
import { createAnthropicClient, readFederation } from '../shared/anthropic-client';
import { costUsd, priceOf, type Price } from './pricing';
import { f1, scoreClassify, scoreOcr, type ClassifyCase, type ClassifyScore, type OcrScore } from './score';

/**
 * OCR とカテゴリ判定を、モデルを替えて保存済みのレシートでやり直し、速さ・費用・正解との一致を測る。
 * 本番の経路（画面・API）からは呼ばない。人が `aws lambda invoke` で 1 回ずつ起こす（docs/operations.md）。
 *
 * 1 回の呼び出しで測るのは 1 つの組（仕事 × モデル × effort）。結果は CloudWatch Logs に
 * `[bench] result`（レシート 1 枚ごと）と `[bench] summary`（まとめ）の 1 行の JSON で出す。
 * 中身（品目名・金額・店名・日付・画像）はログに出さない。出すのは点数・時間・トークン数だけ。
 *
 * 指示文と後始末（ocr-receipt/draft.ts）、判定の材料と採否（packages/core の classify）は
 * 本番と同じものを使う。モデルの当たり外れだけが差になるようにしておくため。
 * 本番の OCR と違って Bedrock への読み直しはしない。別のモデルの答えが混ざると比べられなくなる。
 */

const TABLE_NAME = requireEnv('TABLE_NAME');
const RECEIPT_BUCKET = requireEnv('RECEIPT_BUCKET');

const s3 = new S3Client({});
const documents = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/** 1 回の呼び出しの待ち時間。上位のモデルを高い effort で回すと、1 枚に数分かかることがある */
const ANTHROPIC_TIMEOUT_MS = 5 * 60_000;
const ANTHROPIC_MAX_RETRIES = 2;
/** 本番の OCR の上限（8,192）より広く取る。高い effort では思考が長くなり、上限で切れると比べられない */
const OCR_MAX_TOKENS = 16_000;

/** 1 回の予算の既定と天井。Claude Console のワークスペースの利用上限とは別に、ここでも止める */
const DEFAULT_MAX_USD = 5;
const MAX_USD_CEILING = 50;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 300;
const DEFAULT_PARALLEL = 3;
const MAX_PARALLEL = 8;
/** 続けてこれだけ落ちたら止める。設定の誤りで全部を落とし続けない */
const MAX_CONSECUTIVE_ERRORS = 3;
/** Lambda の制限時間（15 分）の手前で、新しいレシートを始めないようにする */
const TIME_MARGIN_MS = 2 * 60_000;

const EFFORTS: readonly ClaudeEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export type BenchRequest = {
  task: 'ocr' | 'classify';
  /** Claude のモデル ID、`jev`（本番のカテゴリ判定）、`keywords`（キーワード表） */
  model: string;
  effort: ClaudeEffort;
  /** 新しい順に並べたレシートの、何枚目から何枚を使うか */
  offset: number;
  limit: number;
  maxUsd: number;
  parallel: number;
  price?: Price;
  /** ログで組を見分けるための名前 */
  label: string;
};

/** 呼び出しの本文を確かめて、既定を埋める。おかしなものは理由を返す */
export function parseRequest(event: Record<string, unknown>): BenchRequest | { error: string } {
  const task = event.task;
  if (task !== 'ocr' && task !== 'classify') return { error: 'task は ocr か classify' };

  const model = typeof event.model === 'string' ? event.model.trim() : '';
  if (model === '') return { error: 'model が要る' };
  const isClaude = model.startsWith('claude-');
  if (!isClaude && !(task === 'classify' && (model === 'jev' || model === 'keywords'))) {
    return { error: 'model は claude-* か、classify なら jev / keywords' };
  }

  // 既定の effort は本番の OCR と同じ low
  const effort = event.effort === undefined ? 'low' : event.effort;
  if (!EFFORTS.includes(effort as ClaudeEffort)) return { error: `effort は ${EFFORTS.join(' / ')} のどれか` };

  const price = parsePrice(event.price);
  if (price === null) return { error: 'price は { "input": 数, "output": 数 }（100 万トークンあたりのドル）' };
  if (isClaude && !priceOf(model, price)) {
    return { error: `${model} の料金が分からない。price で渡す（100 万トークンあたりのドル）` };
  }

  return {
    task,
    model,
    effort: effort as ClaudeEffort,
    offset: clampInt(event.offset, 0, 0, Number.MAX_SAFE_INTEGER),
    limit: clampInt(event.limit, DEFAULT_LIMIT, 1, MAX_LIMIT),
    maxUsd: clampNumber(event.maxUsd, DEFAULT_MAX_USD, 0, MAX_USD_CEILING),
    parallel: clampInt(event.parallel, DEFAULT_PARALLEL, 1, MAX_PARALLEL),
    ...(price ? { price } : {}),
    label: typeof event.label === 'string' && event.label !== '' ? event.label.slice(0, 60) : `${task}:${model}:${effort}`,
  };
}

/** 渡されていなければ undefined、形が違えば null */
function parsePrice(value: unknown): Price | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null) return null;
  const { input, output } = value as { input?: unknown; output?: unknown };
  if (typeof input !== 'number' || typeof output !== 'number' || !(input >= 0) || !(output >= 0)) return null;
  return { input, output };
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(Math.max(Math.floor(value), min), max) : fallback;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(Math.max(value, min), max) : fallback;
}

type Owner = { categories: Category[]; rules: CategoryRule[] };
type Sample = { receipt: Receipt; owner: Owner };

type Measured = {
  ms: number;
  usd: number;
  usage?: ClaudeUsage;
  servedModel?: string;
  stopReason?: string | null;
};

type Outcome =
  | ({ receiptId: string; status: 'ok'; photos?: number } & Measured & ({ ocr: OcrScore } | { classify: ClassifyScore }))
  | { receiptId: string; status: 'skipped'; reason: string }
  | { receiptId: string; status: 'error'; error: string; usd: number };

export async function handler(
  event: Record<string, unknown>,
  context?: { getRemainingTimeInMillis(): number },
): Promise<Record<string, unknown>> {
  const request = parseRequest(event ?? {});
  if ('error' in request) {
    console.error('[bench] failed', { reason: request.error });
    return { error: request.error };
  }
  const runId = `${new Date().toISOString()}-${Math.random().toString(36).slice(2, 8)}`;

  const anthropic = request.model.startsWith('claude-') ? claudeClient() : undefined;
  const samples = selectSamples(await loadSamples(), request);
  console.info('[bench] start', JSON.stringify({ runId, ...request, samples: samples.length }));

  const outcomes: Outcome[] = [];
  let spent = 0;
  let consecutiveErrors = 0;
  let stopped: string | undefined;

  await runPool(samples, request.parallel, async (sample) => {
    if (stopped) return;
    if (overBudget(request, spent)) stopped = 'budget';
    else if (context && context.getRemainingTimeInMillis() < TIME_MARGIN_MS) stopped = 'time';
    if (stopped) return;

    const outcome = await runOne(request, sample, anthropic);
    outcomes.push(outcome);
    if (outcome.status !== 'skipped') spent += outcome.usd;
    console.info('[bench] result', JSON.stringify({ runId, label: request.label, ...outcome }));

    if (outcome.status === 'error') {
      consecutiveErrors += 1;
      if (isSpendLimit(outcome.error)) stopped = 'spend_limit';
      else if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) stopped = 'errors';
    } else if (outcome.status === 'ok') {
      consecutiveErrors = 0;
    }
  });

  const summary = { runId, ...request, stopped: stopped ?? null, ...summarize(outcomes) };
  console.info('[bench] summary', JSON.stringify(summary));
  return summary;
}

/**
 * 予算に届いたか。予算で止めるのは Claude の組だけ。jev と keywords はここで費用を数えない（usd は常に 0）ので、
 * maxUsd が 0 でも止めない。止めると「使った 0 ≥ 予算 0」で 1 枚も測らずに終わる
 */
export function overBudget(request: Pick<BenchRequest, 'model' | 'maxUsd'>, spent: number): boolean {
  return request.model.startsWith('claude-') && spent >= request.maxUsd;
}

function claudeClient(): Anthropic {
  const federation = readFederation();
  if (!federation) throw new Error('Claude API の ID 連携の値（ANTHROPIC_FEDERATION_RULE_ID ほか）が無い');
  return createAnthropicClient(federation, { timeout: ANTHROPIC_TIMEOUT_MS, maxRetries: ANTHROPIC_MAX_RETRIES });
}

/**
 * 保存済みのレシートと、その持ち主のカテゴリ・ルールを集める。利用者は本人ひとりで、
 * テーブルは数千行なので、Scan で全部見る。消したレシート（discarded）は正解にならないので外す。
 */
async function loadSamples(): Promise<Sample[]> {
  const receipts: { pk: string; receipt: Receipt }[] = [];
  const owners = new Map<string, Owner>();
  const ownerOf = (pk: string) => {
    let owner = owners.get(pk);
    if (!owner) {
      owner = { categories: SEED_CATEGORIES, rules: [] };
      owners.set(pk, owner);
    }
    return owner;
  };

  let start: Record<string, unknown> | undefined;
  do {
    const page = await documents.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'begins_with(sk, :receipt) OR sk IN (:categories, :rules)',
        ExpressionAttributeValues: { ':receipt': 'RECEIPT#', ':categories': 'CONFIG#categories', ':rules': 'CONFIG#rules' },
        ExclusiveStartKey: start,
      }),
    );
    for (const item of page.Items ?? []) {
      const pk = String(item.pk);
      const sk = String(item.sk);
      if (sk === 'CONFIG#categories' && Array.isArray(item.categories)) {
        ownerOf(pk).categories = withLaterSeeds(item.categories as Category[]);
      } else if (sk === 'CONFIG#rules' && Array.isArray(item.rules)) {
        ownerOf(pk).rules = item.rules as CategoryRule[];
      } else if (sk.startsWith('RECEIPT#')) {
        receipts.push({ pk, receipt: item as unknown as Receipt });
      }
    }
    start = page.LastEvaluatedKey;
  } while (start);

  return receipts
    .filter(({ receipt }) => receipt.status !== 'discarded' && Array.isArray(receipt.items) && receipt.items.length > 0)
    .map(({ pk, receipt }) => ({ receipt, owner: ownerOf(pk) }));
}

/**
 * 仕事に使えるレシートを新しい順に並べて切り出す。組を替えても同じレシートの並びになるので、
 * offset と limit が同じなら、モデルの違いだけを比べられる。
 * OCR は写真が残っているもの（90 日で消える）だけ。判定は品目名とカテゴリだけを使うので写真は要らない。
 */
export function selectSamples(samples: Sample[], request: Pick<BenchRequest, 'task' | 'offset' | 'limit'>): Sample[] {
  return samples
    .filter(({ receipt }) => (request.task === 'ocr' ? photoKeys(receipt).length > 0 : classifyItems(receipt).length > 0))
    .sort((a, b) => (b.receipt.date ?? '').localeCompare(a.receipt.date ?? '') || a.receipt.id.localeCompare(b.receipt.id))
    .slice(request.offset, request.offset + request.limit);
}

function photoKeys(receipt: Receipt): string[] {
  if (Array.isArray(receipt.imageKeys) && receipt.imageKeys.length > 0) return receipt.imageKeys;
  return receipt.imageKey ? [receipt.imageKey] : [];
}

/** 判定にかける品目。値引き（負の金額）は本番でも聞かないので外す。カテゴリの無い品目は正解が無い */
function classifyItems(receipt: Receipt): number[] {
  return receipt.items.flatMap((item, index) => (item.amount >= 0 && item.categoryId ? [index] : []));
}

async function runOne(request: BenchRequest, sample: Sample, anthropic: Anthropic | undefined): Promise<Outcome> {
  const receiptId = sample.receipt.id;
  try {
    return request.task === 'ocr'
      ? await runOcr(request, sample, anthropic!)
      : await runClassify(request, sample, anthropic);
  } catch (cause) {
    if (cause instanceof Skip) return { receiptId, status: 'skipped', reason: cause.message };
    const usd = cause instanceof Spent ? cause.usd : 0;
    return { receiptId, status: 'error', error: describeError(cause instanceof Spent ? cause.failure : cause), usd };
  }
}

/** 測らずに飛ばしたもの（写真が消えていた、など）。費用は掛かっていない */
class Skip extends Error {}

/** 費用が掛かった後で失敗したもの。予算に数えるため、掛かった分を持たせる */
class Spent extends Error {
  constructor(
    readonly usd: number,
    readonly failure: unknown,
  ) {
    super('spent');
  }
}

async function runOcr(request: BenchRequest, sample: Sample, anthropic: Anthropic): Promise<Outcome> {
  const keys = photoKeys(sample.receipt);
  const images = await Promise.all(keys.map(loadImage));

  const started = Date.now();
  const message = await anthropic.messages.create({
    model: request.model,
    max_tokens: OCR_MAX_TOKENS,
    output_config: { effort: request.effort },
    messages: [
      {
        role: 'user',
        content: [
          ...images.map((image) => ({
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: image.mediaType as 'image/jpeg' | 'image/png' | 'image/webp',
              data: image.base64,
            },
          })),
          { type: 'text' as const, text: buildPrompt(images.length) },
        ],
      },
    ],
  });
  const ms = Date.now() - started;
  const usage = usageOf(message.usage);
  const usd = costUsd(usage, priceOf(request.model, request.price)!);

  if (message.stop_reason === 'refusal') throw new Spent(usd, new Error('refusal'));
  const text = message.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
  const draft = normalizeDraft(text, new Date());

  return {
    receiptId: sample.receipt.id,
    status: 'ok',
    photos: images.length,
    ms,
    usd,
    usage,
    servedModel: message.model,
    stopReason: message.stop_reason,
    ocr: scoreOcr(sample.receipt, draft),
  };
}

async function runClassify(request: BenchRequest, sample: Sample, anthropic: Anthropic | undefined): Promise<Outcome> {
  const { receipt, owner } = sample;
  const indexes = classifyItems(receipt);
  const { ruled } = applyItemRules(receipt.items, owner.rules);

  // 画面（src/api/classify.ts の judgeReceiptItems）と同じ材料にする。人が覚えさせた品目も聞くのは、
  // それが一番確かな正解だから（本番では聞かずにルールで決める）
  const target: ClassifyTarget = {
    kind: 'item',
    categories: owner.categories,
    subjects: indexes.map((index) => ({
      key: String(index),
      text: receipt.items[index].name,
      ...(receipt.storeName ? { context: receipt.storeName } : {}),
    })),
  };
  const cases: Record<string, ClassifyCase> = Object.fromEntries(
    indexes.map((index) => [String(index), { truth: receipt.items[index].categoryId!, ruled: ruled.has(index) }]),
  );

  const started = Date.now();
  let verdicts: Record<string, Verdict>;
  let measured: Omit<Measured, 'ms'> = { usd: 0 };

  if (request.model === 'keywords') {
    verdicts = Object.fromEntries(
      indexes.map((index) => {
        const item = receipt.items[index];
        return [String(index), { categoryId: classifyItem(item.name, undefined, item.amount), confidence: 1, status: 'accepted' }];
      }),
    );
  } else if (request.model === 'jev') {
    // Jev の費用は TypeSafe の請求で、ここでは数えない（usd は 0）
    const client = await clientOnce();
    const state = buildState(target);
    const parents = await ask(client, state, parentChoiceSpecs(target));
    const children = await ask(client, state, childChoiceSpecs(target, parents));
    verdicts = decideVerdicts(target, parents, children);
  } else {
    const price = priceOf(request.model, request.price)!;
    const state = buildState(target);
    const options = { model: request.model, effort: request.effort };
    let usd = 0;
    let usage: ClaudeUsage = { input: 0, output: 0, thinking: 0, cacheRead: 0, cacheWrite: 0 };
    let servedModel: string | undefined;
    const step = async (specs: ReturnType<typeof parentChoiceSpecs>) => {
      if (specs.length === 0) return {};
      try {
        const result = await askClaude(anthropic!, options, state, specs);
        usage = addUsage(usage, result.usage);
        usd += costUsd(result.usage, price);
        servedModel = result.servedModel;
        return result.answers;
      } catch (cause) {
        throw new Spent(usd, cause);
      }
    };
    const parents = await step(parentChoiceSpecs(target));
    const children = await step(childChoiceSpecs(target, parents));
    verdicts = decideVerdicts(target, parents, children);
    measured = { usd, usage, ...(servedModel ? { servedModel } : {}) };
  }

  return {
    receiptId: receipt.id,
    status: 'ok',
    ms: Date.now() - started,
    ...measured,
    classify: scoreClassify(cases, verdicts, owner.categories),
  };
}

async function loadImage(key: string): Promise<{ base64: string; mediaType: string }> {
  try {
    const object = await s3.send(new GetObjectCommand({ Bucket: RECEIPT_BUCKET, Key: key }));
    if (!object.Body) throw new Skip('image_missing');
    return toOcrImage(await object.Body.transformToByteArray());
  } catch (cause) {
    // 写真は 90 日で消える（data-stack の lifecycle）。消えていたレシートは測らずに飛ばす
    if (cause instanceof NoSuchKey) throw new Skip('image_expired');
    if (cause instanceof Skip) throw cause;
    throw new Skip(`image_unreadable: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

function usageOf(usage: Anthropic.Usage): ClaudeUsage {
  return {
    input: usage.input_tokens,
    output: usage.output_tokens,
    thinking: usage.output_tokens_details?.thinking_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
  };
}

function addUsage(a: ClaudeUsage, b: ClaudeUsage): ClaudeUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    thinking: a.thinking + b.thinking,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

/** ログに出す失敗の要約。SDK の例外は status と文言だけにする（本文やヘッダを持ち込まない） */
function describeError(cause: unknown): string {
  if (cause instanceof APIError) return `${cause.name}(${String(cause.status)}): ${cause.message.slice(0, 300)}`;
  if (cause instanceof Error) return `${cause.name}: ${cause.message.slice(0, 300)}`;
  return String(cause).slice(0, 300);
}

/**
 * クレジットの残高切れか、ワークスペースの利用上限（Claude Console で掛けたもの）に当たった。
 * 続けても全部落ちるので、その場で止める。
 */
export function isSpendLimit(error: string): boolean {
  return /credit balance|spend(ing)? limit|usage limit/i.test(error);
}

/** 同時に parallel 個ずつ流す */
async function runPool<T>(items: T[], parallel: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(parallel, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await work(item);
    }
  });
  await Promise.all(lanes);
}

/** 結果をまとめる。率は測れた（ok の）ものだけで割る */
export function summarize(outcomes: Outcome[]): Record<string, unknown> {
  const ok = outcomes.filter((outcome): outcome is Extract<Outcome, { status: 'ok' }> => outcome.status === 'ok');
  const usd = outcomes.reduce((sum, outcome) => sum + (outcome.status === 'skipped' ? 0 : outcome.usd), 0);
  const ms = ok.map((outcome) => outcome.ms).sort((a, b) => a - b);
  const tokens = ok.reduce(
    (sum, outcome) => (outcome.usage ? addUsage(sum, outcome.usage) : sum),
    { input: 0, output: 0, thinking: 0, cacheRead: 0, cacheWrite: 0 } as ClaudeUsage,
  );
  const servedModels = [...new Set(ok.flatMap((outcome) => (outcome.servedModel ? [outcome.servedModel] : [])))];

  const base = {
    ok: ok.length,
    errors: outcomes.filter((outcome) => outcome.status === 'error').length,
    skipped: outcomes.filter((outcome) => outcome.status === 'skipped').length,
    usd: round(usd, 4),
    usdPerReceipt: ok.length > 0 ? round(usd / ok.length, 4) : null,
    msMean: ms.length > 0 ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : null,
    msP50: percentile(ms, 0.5),
    msP90: percentile(ms, 0.9),
    tokens,
    servedModels,
  };

  const ocr = ok.flatMap((outcome) => ('ocr' in outcome ? [outcome.ocr] : []));
  if (ocr.length > 0) {
    const rate = (pick: (score: OcrScore) => boolean) => round(ocr.filter(pick).length / ocr.length, 3);
    const sum = (pick: (score: OcrScore) => number) => ocr.reduce((total, score) => total + pick(score), 0);
    return {
      ...base,
      ocr: {
        total: rate((score) => score.total),
        date: rate((score) => score.date),
        store: rate((score) => score.store),
        balanced: rate((score) => score.balanced),
        perfect: rate((score) => score.total && score.date && score.amountF1 === 1),
        itemF1Mean: round(sum((score) => score.itemF1) / ocr.length, 3),
        amountF1Mean: round(sum((score) => score.amountF1) / ocr.length, 3),
        // 品目を全部まとめた F1（品目の多いレシートが重く効く）
        itemF1Pooled: round(f1(sum((score) => score.exactItems), sum((score) => score.truthItems), sum((score) => score.draftItems)), 3),
        warningsMean: round(sum((score) => score.warnings) / ocr.length, 2),
      },
    };
  }

  const classify = ok.flatMap((outcome) => ('classify' in outcome ? [outcome.classify] : []));
  if (classify.length > 0) {
    const total = classify.reduce(
      (sum, score) => {
        for (const key of Object.keys(sum) as (keyof ClassifyScore)[]) sum[key] += score[key];
        return sum;
      },
      { subjects: 0, exact: 0, root: 0, ruled: 0, ruledExact: 0, accepted: 0, review: 0, unresolved: 0, acceptedExact: 0 },
    );
    const ratio = (a: number, b: number) => (b > 0 ? round(a / b, 3) : null);
    return {
      ...base,
      classify: {
        ...total,
        exactRate: ratio(total.exact, total.subjects),
        rootRate: ratio(total.root, total.subjects),
        ruledExactRate: ratio(total.ruledExact, total.ruled),
        acceptedRate: ratio(total.accepted, total.subjects),
        acceptedPrecision: ratio(total.acceptedExact, total.accepted),
      },
    };
  }
  return base;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
