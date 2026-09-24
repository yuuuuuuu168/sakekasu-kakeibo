import {
  UNCATEGORIZED_ID,
  categoryLabel,
  learnRule,
  normalizeMerchant,
  type Category,
  type CategoryRule,
  type ClassifyTarget,
  type ReceiptItem,
  type Transaction,
  type Verdict,
} from '@kakeibo/core';
import { api } from './index';

/**
 * カテゴリ判定（Jev）を画面から使うための薄い層。
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

/**
 * レシートの品目にカテゴリを当てる。判定が届かなかった品目は、
 * OCR の関数がキーワード表で付けた答えをそのまま残す。
 */
export async function judgeReceiptItems(
  items: ReceiptItem[],
  storeName: string,
  categories: Category[],
): Promise<JudgedItems> {
  const verdicts = await judge({
    kind: 'item',
    categories,
    subjects: items.map((item, index) => ({
      key: String(index),
      text: item.name,
      ...(storeName ? { context: storeName } : {}),
    })),
  });

  const warnings: string[] = [];
  const judged = items.map((item, index) => {
    const verdict = verdicts[String(index)];
    if (!verdict || verdict.status === 'unresolved') return item;
    if (verdict.status === 'review') {
      warnings.push(`「${item.name}」は ${categoryLabel(categories, verdict.categoryId)} と見ましたが、確信は高くありません。`);
    }
    return { ...item, categoryId: verdict.categoryId };
  });

  return { items: judged, warnings };
}

export type JudgedTransactions = {
  transactions: Transaction[];
  /** 確信の高かった店から作ったルール。次の取り込みからは判定を呼ばずに当たる */
  learned: CategoryRule[];
  judged: number;
};

/**
 * 取り込んだ明細のうち、ルールに当たらなかった店を判定に回す。
 *
 * 同じ店が何行あっても 1 回しか聞かない。確信が高ければルールにして覚えるので、
 * 次の月の取り込みではルールが先に当たり、判定そのものを呼ばなくなる。
 * 確信が中くらいならカテゴリだけ入れて、ルールは作らない（間違いを固定しないため）。
 */
export async function judgeUnmatchedMerchants(
  transactions: Transaction[],
  categories: Category[],
): Promise<JudgedTransactions> {
  // 正規化した店舗名で 1 つにまとめる。表記が揺れただけの同じ店を 2 回聞かない
  const unknown = new Map<string, string>();
  for (const txn of transactions) {
    if (!isUnclassified(txn)) continue;
    const key = normalizeMerchant(txn.rawMerchant);
    if (key === '' || unknown.has(key)) continue;
    unknown.set(key, txn.rawMerchant);
  }

  const keys = [...unknown.keys()];
  const verdicts = await judge({
    kind: 'merchant',
    categories,
    subjects: keys.map((key) => ({ key, text: unknown.get(key) ?? key })),
  });

  const learned: CategoryRule[] = [];
  for (const key of keys) {
    const verdict = verdicts[key];
    if (verdict?.status === 'accepted') learned.push(learnRule(unknown.get(key) ?? key, verdict.categoryId));
  }

  const judged = transactions.map((txn) => {
    if (!isUnclassified(txn)) return txn;
    const verdict = verdicts[normalizeMerchant(txn.rawMerchant)];
    if (!verdict || verdict.status === 'unresolved') return txn;
    return {
      ...txn,
      splits: txn.splits.map((split) => ({ ...split, categoryId: verdict.categoryId })),
    };
  });

  return {
    transactions: judged,
    learned,
    judged: keys.filter((key) => verdicts[key] && verdicts[key].status !== 'unresolved').length,
  };
}

/** ルールに当たらなかった明細。内訳がまだ 1 行で、未分類のまま */
function isUnclassified(txn: Transaction): boolean {
  return txn.splits.length === 1 && txn.splits[0].categoryId === UNCATEGORIZED_ID;
}
