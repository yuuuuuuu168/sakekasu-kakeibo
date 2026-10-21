import Anthropic from '@anthropic-ai/sdk';
import { oidcFederationProvider } from '@anthropic-ai/sdk/lib/credentials/oidc-federation';
import { GetWebIdentityTokenCommand, STSClient } from '@aws-sdk/client-sts';
import { IDENTITY_TOKEN_AUDIENCE, IDENTITY_TOKEN_SECONDS } from '../ocr-receipt/llm-constants';

/**
 * Claude API に Workload Identity Federation で入るクライアント。API キーは持たない。
 * この関数のロールで STS の GetWebIdentityToken を呼んで AWS が署名した JWT をもらい、
 * SDK が Anthropic の短命のトークンと交換する（期限の前に自分でやり直す）。
 *
 * OCR（ocr-receipt）とモデルの評価（model-bench）が使う。Claude Console のルールは
 * ロールの ARN を照合するので、関数ごとにルールが要る（docs/operations.md）。
 */

export type AnthropicFederationEnv = {
  ruleId: string;
  organizationId: string;
  serviceAccountId: string;
  workspaceId?: string;
};

/** 環境変数から ID 連携の値を読む。揃っていなければ undefined */
export function readFederation(env: NodeJS.ProcessEnv = process.env): AnthropicFederationEnv | undefined {
  const ruleId = env.ANTHROPIC_FEDERATION_RULE_ID;
  const organizationId = env.ANTHROPIC_ORGANIZATION_ID;
  const serviceAccountId = env.ANTHROPIC_SERVICE_ACCOUNT_ID;
  if (!ruleId || !organizationId || !serviceAccountId) return undefined;
  return { ruleId, organizationId, serviceAccountId, workspaceId: env.ANTHROPIC_WORKSPACE_ID || undefined };
}

export function createAnthropicClient(
  federation: AnthropicFederationEnv,
  options: { timeout: number; maxRetries: number },
): Anthropic {
  // GetWebIdentityToken は地域ごとの STS にしかない。発行者 URL は global なので、どの地域で呼んでも同じ
  const sts = new STSClient({ region: process.env.AWS_REGION });
  return new Anthropic({
    // ログの水準は既定（warn）のまま。debug にすると本文とヘッダが CloudWatch に出る
    timeout: options.timeout,
    maxRetries: options.maxRetries,
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
