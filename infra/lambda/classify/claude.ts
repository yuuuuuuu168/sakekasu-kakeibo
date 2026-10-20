import type Anthropic from '@anthropic-ai/sdk';
import type { ChoiceAnswer, ChoiceSpec } from '@kakeibo/core';
import type { JsonValue } from '@typesafe-ai/sdk';

/**
 * カテゴリ判定の 1 段ぶんを Claude に聞く。本番の判定は Jev（index.ts）で、こちらは
 * モデルを比べる評価（model-bench）からだけ使う。材料（state と ChoiceSpec）も、答えの採否
 * （decideVerdicts）も Jev と同じものを使い、聞き方だけを差し替えられるようにしてある。
 *
 * Jev は校正された確信度を返すが、Claude の confidence は自己申告で、校正されていない。
 * 同じ線（ACCEPT / REVIEW）で採否を決めると、Claude には甘く出ることがある。
 * 比べるときは「当たったか」を主に見て、確信度の線はおまけとして読む。
 *
 * 送るのは Jev と同じく品目名・店舗名・カテゴリ名（と ID）だけ。金額・日付・画像は送らない。
 */

export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type ClaudeUsage = {
  input: number;
  output: number;
  /** output のうち思考に使った分 */
  thinking: number;
  cacheRead: number;
  cacheWrite: number;
};

export type ClaudeAskResult = {
  answers: Record<string, ChoiceAnswer>;
  usage: ClaudeUsage;
  /** 実際に答えたモデル（response.model） */
  servedModel: string;
  stopReason: string | null;
};

/** 1 枚のレシートの品目は多くても数十。思考を足しても 16,000 で足りる（非ストリーミングの上限の内側） */
const MAX_TOKENS = 16_000;

/** モデルが断ったとき。答えを作らずに失敗として数える */
export class ClaudeRefusalError extends Error {}

const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    answers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          choice: { type: 'string' },
          confidence: { type: 'number' },
        },
        required: ['name', 'choice', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['answers'],
  additionalProperties: false,
} as const;

/** 問いの文。Jev に渡すもの（instructions と criteria）をそのまま並べる */
export function buildClassifyPrompt(state: Record<string, JsonValue>, specs: ChoiceSpec[]): string {
  const questions = specs.map((spec) => ({ name: spec.name, 問い: spec.instructions, 選択肢: spec.criteria }));
  return `家計簿のカテゴリ判定です。次のデータを読んで、すべての問いに答えてください。

データ:
${JSON.stringify(state)}

問い（選択肢はラベル → 説明）:
${JSON.stringify(questions)}

問いごとに、name、選んだラベル（choice）、そのラベルが正しい確からしさ（confidence、0 から 1）を返すこと。
choice には選択肢のラベルをそのまま書き、説明の文を書かないこと。`;
}

export async function askClaude(
  client: Pick<Anthropic, 'messages'>,
  options: { model: string; effort: ClaudeEffort },
  state: Record<string, JsonValue>,
  specs: ChoiceSpec[],
): Promise<ClaudeAskResult> {
  const message = await client.messages.create({
    model: options.model,
    max_tokens: MAX_TOKENS,
    // 思考は既定（adaptive）のまま。止められないモデルがあるので、深さは effort だけで変える
    output_config: { effort: options.effort, format: { type: 'json_schema', schema: ANSWER_SCHEMA } },
    messages: [{ role: 'user', content: buildClassifyPrompt(state, specs) }],
  });

  const usage: ClaudeUsage = {
    input: message.usage.input_tokens,
    output: message.usage.output_tokens,
    thinking: message.usage.output_tokens_details?.thinking_tokens ?? 0,
    cacheRead: message.usage.cache_read_input_tokens ?? 0,
    cacheWrite: message.usage.cache_creation_input_tokens ?? 0,
  };
  if (message.stop_reason === 'refusal') throw new ClaudeRefusalError('モデルが判定を断りました');

  const text = message.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
  return {
    answers: parseClaudeAnswers(text, specs),
    usage,
    servedModel: message.model,
    stopReason: message.stop_reason,
  };
}

/**
 * Claude の答えを、判定に使う形（問いの name → 選んだラベルと確信度）にする。
 * 問いに無い name、選択肢に無いラベル、壊れた値は捨てる。捨てた問いは未分類に落ちる。
 */
export function parseClaudeAnswers(text: string, specs: ChoiceSpec[]): Record<string, ChoiceAnswer> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  const list = (parsed as { answers?: unknown })?.answers;
  if (!Array.isArray(list)) return {};

  const byName = new Map(specs.map((spec) => [spec.name, spec]));
  const answers: Record<string, ChoiceAnswer> = {};
  for (const value of list) {
    if (typeof value !== 'object' || value === null) continue;
    const { name, choice, confidence } = value as { name?: unknown; choice?: unknown; confidence?: unknown };
    if (typeof name !== 'string' || typeof choice !== 'string') continue;
    const spec = byName.get(name);
    if (!spec || !Object.hasOwn(spec.criteria, choice)) continue;
    if (typeof confidence !== 'number' || !Number.isFinite(confidence)) continue;
    answers[name] = { choice, confidence: Math.min(Math.max(confidence, 0), 1) };
  }
  return answers;
}
