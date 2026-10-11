/**
 * レシートの OCR が Claude API に入るための Workload Identity Federation の値。
 * Claude Console の Settings → Workload identity で作ったルール・サービスアカウントの ID。
 *
 * どれも秘密ではない（鍵ではなく、どのルールで交換するかの指定）。鍵に当たるものは
 * 毎回 STS が発行する JWT で、どこにも置かない。`cdk.json` の context `anthropicFederation` に書く。
 * 手順は docs/operations.md の「Claude API の ID 連携」にある。
 *
 * ルールが照合するのは OCR の Lambda のロールの ARN（`sakekasu-kakeibo-{env}-ocr-receipt`）なので、
 * 環境を足すときは Claude Console にその環境のロールのルールを足す。
 */
export interface AnthropicFederation {
  /** フェデレーションルール（fdrl_...） */
  ruleId: string;
  /** Anthropic の組織 ID（UUID） */
  organizationId: string;
  /** サービスアカウント（svac_...） */
  serviceAccountId: string;
  /** ワークスペース（wrkspc_...）。ルールが 1 つのワークスペースに絞ってあれば省ける */
  workspaceId?: string;
}

const RULE_ID = /^fdrl_[A-Za-z0-9]+$/;
const ORGANIZATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SERVICE_ACCOUNT_ID = /^svac_[A-Za-z0-9]+$/;
const WORKSPACE_ID = /^wrkspc_[A-Za-z0-9]+$/;

/**
 * context の値を確かめて AnthropicFederation に直す。
 *
 * 無ければ undefined（OCR は Bedrock だけで読む）。書いてあるのに形が違うときは落とす。
 * 打ち間違いのまま出すと、毎回 Claude API で失敗してから Bedrock に回ることになり、気づきにくい。
 */
export function parseAnthropicFederation(value: unknown): AnthropicFederation | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object') {
    throw new Error('context の anthropicFederation は { "ruleId", "organizationId", "serviceAccountId", "workspaceId" } で書く');
  }
  const { ruleId, organizationId, serviceAccountId, workspaceId } = value as Record<string, unknown>;
  if (typeof ruleId !== 'string' || !RULE_ID.test(ruleId)) {
    throw new Error(`anthropicFederation.ruleId が不正です（fdrl_ で始まる）: ${String(ruleId)}`);
  }
  if (typeof organizationId !== 'string' || !ORGANIZATION_ID.test(organizationId)) {
    throw new Error(`anthropicFederation.organizationId が不正です（UUID）: ${String(organizationId)}`);
  }
  if (typeof serviceAccountId !== 'string' || !SERVICE_ACCOUNT_ID.test(serviceAccountId)) {
    throw new Error(`anthropicFederation.serviceAccountId が不正です（svac_ で始まる）: ${String(serviceAccountId)}`);
  }
  if (workspaceId !== undefined && (typeof workspaceId !== 'string' || !WORKSPACE_ID.test(workspaceId))) {
    throw new Error(`anthropicFederation.workspaceId が不正です（wrkspc_ で始まる）: ${String(workspaceId)}`);
  }
  return { ruleId, organizationId, serviceAccountId, ...(workspaceId ? { workspaceId } : {}) };
}
