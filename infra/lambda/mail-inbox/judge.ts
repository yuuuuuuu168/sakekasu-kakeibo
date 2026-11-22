import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import {
  applyItemVerdicts,
  planItemJudgement,
  type Category,
  type CategoryRule,
  type ReceiptItem,
  type Verdict,
} from '@kakeibo/core';

/*
 * 下書きの品目のカテゴリを、画面で写真から読んだときと同じ順番で決める。
 * 覚えた品目のルール → 判定（Jev）→ キーワード表（draft.ts で当て済み）。採否は core の classify.ts にある。
 *
 * Jev は classify の関数を直接呼ぶ。TypeSafe の鍵を持つのはあの関数だけにしておきたいため。
 * 判定は無くても進む。呼べなかった・遅かった・落ちたときは、ルールとキーワード表の答えのまま置き、
 * 決まらなかった品目は未分類として画面で人が決める。
 */

const lambda = new LambdaClient({});

/** 判定を待つ長さ。API Gateway の 30 秒に収まるよう、ほかの処理の分を残しておく */
const JUDGE_TIMEOUT_MS = 12_000;

export async function judgeItems(
  items: ReceiptItem[],
  storeName: string,
  categories: Category[],
  rules: CategoryRule[],
  sub: string,
): Promise<ReceiptItem[]> {
  const plan = planItemJudgement(items, storeName, categories, rules);
  const functionName = process.env.CLASSIFY_FUNCTION_NAME;
  if (!functionName || plan.target.subjects.length === 0) return plan.items;

  try {
    const verdicts = await invokeClassify(functionName, plan.target, sub);
    return applyItemVerdicts(plan, verdicts, categories).items;
  } catch (cause) {
    console.warn('[mail-inbox] 判定を飛ばしました', cause instanceof Error ? cause.name : 'unknown');
    return plan.items;
  }
}

async function invokeClassify(functionName: string, target: unknown, sub: string): Promise<Record<string, Verdict>> {
  // classify の関数は API Gateway の形で受ける。JWT の検証は API Gateway の仕事なので、ここでは sub だけを渡す
  const event = {
    requestContext: { authorizer: { jwt: { claims: { sub } } } },
    body: JSON.stringify(target),
    isBase64Encoded: false,
  };
  const result = await lambda.send(
    new InvokeCommand({ FunctionName: functionName, Payload: Buffer.from(JSON.stringify(event)) }),
    { abortSignal: AbortSignal.timeout(JUDGE_TIMEOUT_MS) },
  );
  if (result.FunctionError || !result.Payload) throw new Error('classify failed');
  const response = JSON.parse(Buffer.from(result.Payload).toString('utf-8')) as { statusCode?: number; body?: string };
  if (response.statusCode !== 200 || !response.body) throw new Error(`classify returned ${response.statusCode}`);
  const verdicts = (JSON.parse(response.body) as { verdicts?: unknown }).verdicts;
  return typeof verdicts === 'object' && verdicts !== null ? (verdicts as Record<string, Verdict>) : {};
}
