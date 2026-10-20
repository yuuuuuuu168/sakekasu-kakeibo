import {
  applyItemVerdicts,
  applyMerchantVerdicts,
  planItemJudgement,
  planMerchantJudgement,
  type Category,
  type CategoryRule,
  type ClassifyTarget,
  type ReceiptItem,
  type Transaction,
  type Verdict,
} from '@kakeibo/core';
import { api } from './index';

/**
 * カテゴリ判定（Jev）を画面から使うための薄い層。何を聞くか（plan）と答えの採否（apply）は
 * core の classify.ts にあり、ここは判定を呼ぶことと、落ちたときに空で返すことだけをする。
 *
 * 判定は「あれば嬉しい」ものとして扱う。AWS の無いローカルモード、鍵の設定漏れ、
 * TypeSafe 側の不調、どれで転んでもレシートは登録できて明細は取り込める。
 * 落ちたときはキーワード表とルールの答えがそのまま残る。
 */
async function judge(target: ClassifyTarget): Promise<Record<string, Verdict>> {
  if (target.subjects.length === 0) return {};
  try {
    return await api.classify(target);
  } catch (cause) {
    // 判定が無くても先に進めるので、画面は止めずログだけ残す
    console.warn('[classify] 判定を飛ばしました', cause);
    return {};
  }
}

export type JudgedItems = {
  items: ReceiptItem[];
  /** 確信が低かったもの。レシートの下書きの注意書きに混ぜる */
  warnings: string[];
};

/** レシートの品目にカテゴリを当てる。順番と採否は core の planItemJudgement / applyItemVerdicts */
export async function judgeReceiptItems(
  items: ReceiptItem[],
  storeName: string,
  categories: Category[],
  rules: CategoryRule[] = [],
): Promise<JudgedItems> {
  const plan = planItemJudgement(items, storeName, categories, rules);
  return applyItemVerdicts(plan, await judge(plan.target), categories);
}

export type JudgedTransactions = {
  transactions: Transaction[];
  /** 確信の高かった店から作ったルール。次の取り込みからは判定を呼ばずに当たる */
  learned: CategoryRule[];
  judged: number;
};

/** 取り込んだ明細のうち、ルールに当たらなかった店を判定に回す。採否は core の applyMerchantVerdicts */
export async function judgeUnmatchedMerchants(
  transactions: Transaction[],
  categories: Category[],
): Promise<JudgedTransactions> {
  const plan = planMerchantJudgement(transactions, categories);
  return applyMerchantVerdicts(transactions, plan, await judge(plan.target), categories);
}
