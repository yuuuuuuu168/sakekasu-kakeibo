import { describe, expect, it } from 'vitest';
import { parseAnthropicFederation } from '../lib/anthropic-federation';

const VALID = {
  ruleId: 'fdrl_01R8xap4MEfkrvAF7BFCwjee',
  organizationId: 'c155ee76-4f2a-4282-aae0-a453dd5145af',
  serviceAccountId: 'svac_013YQL3yjR64npq3BKSccX3m',
  workspaceId: 'wrkspc_01Di2E3sdUtKughzMZ49idak',
};

describe('parseAnthropicFederation', () => {
  it('書いていなければ undefined（OCR は Bedrock だけで読む）', () => {
    expect(parseAnthropicFederation(undefined)).toBeUndefined();
  });

  it('形の合う値はそのまま通す', () => {
    expect(parseAnthropicFederation(VALID)).toEqual(VALID);
  });

  it('workspaceId は省ける', () => {
    const { workspaceId: _workspaceId, ...rest } = VALID;
    expect(parseAnthropicFederation(rest)).toEqual(rest);
  });

  // 打ち間違いのまま出すと、毎回 Claude API で失敗してから Bedrock に回るだけで気づきにくい
  it.each([
    ['ruleId', 'rule_123'],
    ['organizationId', 'not-a-uuid'],
    ['serviceAccountId', 'sa_123'],
    ['workspaceId', 'default'],
  ])('%s の形が違えば合成で落とす', (key, value) => {
    expect(() => parseAnthropicFederation({ ...VALID, [key]: value })).toThrow(key);
  });
});
