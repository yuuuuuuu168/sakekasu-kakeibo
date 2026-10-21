import { describe, expect, it, vi } from 'vitest';
import type { ChoiceSpec } from '@kakeibo/core';
import { ClaudeRefusalError, askClaude, parseClaudeAnswers } from '../claude';

const specs: ChoiceSpec[] = [
  { name: '0', instructions: '「パン」は、家計のどの費目になりますか。', criteria: { food: '食費', daily: '日用品' } },
  { name: '1', instructions: '「洗剤」は、家計のどの費目になりますか。', criteria: { food: '食費', daily: '日用品' } },
];

describe('parseClaudeAnswers', () => {
  it('問いの name と選択肢のラベルに合う答えだけを受け取り、確信度は 0〜1 に収める', () => {
    const text = JSON.stringify({
      answers: [
        { name: '0', choice: 'food', confidence: 1.4 },
        { name: '1', choice: '日用品', confidence: 0.9 },
        { name: '9', choice: 'food', confidence: 0.9 },
      ],
    });
    expect(parseClaudeAnswers(text, specs)).toEqual({ '0': { choice: 'food', confidence: 1 } });
  });

  it('壊れた JSON と、選択肢に無い組み込みの名前（toString など）は捨てる', () => {
    expect(parseClaudeAnswers('{', specs)).toEqual({});
    expect(parseClaudeAnswers(JSON.stringify({ answers: [{ name: '0', choice: 'toString', confidence: 1 }] }), specs)).toEqual({});
  });
});

describe('askClaude', () => {
  const message = (overrides: Record<string, unknown> = {}) => ({
    model: 'claude-opus-5-5',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify({ answers: [{ name: '0', choice: 'food', confidence: 0.95 }] }) }],
    usage: { input_tokens: 100, output_tokens: 50, output_tokens_details: { thinking_tokens: 20 }, cache_read_input_tokens: null, cache_creation_input_tokens: null },
    ...overrides,
  });

  it('effort と構造化出力の形を渡し、使ったトークンを返す', async () => {
    const create = vi.fn().mockResolvedValue(message());
    const result = await askClaude({ messages: { create } } as never, { model: 'claude-opus-5-5', effort: 'medium' }, { 対象: [] }, specs);

    const request = create.mock.calls[0][0];
    expect(request.output_config.effort).toBe('medium');
    expect(request.output_config.format.type).toBe('json_schema');
    // 金額・日付は問いに入れない（品目名とカテゴリ名だけ）
    expect(request.messages[0].content).toContain('パン');
    expect(result).toMatchObject({
      answers: { '0': { choice: 'food', confidence: 0.95 } },
      usage: { input: 100, output: 50, thinking: 20 },
      servedModel: 'claude-opus-5-5',
    });
  });

  it('断られたら失敗にする', async () => {
    const create = vi.fn().mockResolvedValue(message({ stop_reason: 'refusal', content: [] }));
    await expect(askClaude({ messages: { create } } as never, { model: 'm', effort: 'low' }, {}, specs)).rejects.toBeInstanceOf(
      ClaudeRefusalError,
    );
  });
});
