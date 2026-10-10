import {
  UNCATEGORIZED_ID,
  applyItemRules,
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
 * 使える答えかどうかを確かめる。手元にあるカテゴリを指していない答えは捨てる。
 *
 * 同じ検査は判定の側（`decideVerdict`）でもしているが、こちらは受け取った ID を
 * 内訳とルールに書き込む側なので、書き込む直前にもう一度見る。画面が知らない
 * カテゴリが内訳に入ると、どの行にも出てこない額ができて、集計が静かに狂う。
 * ルールとして覚えてしまえば、以降の取り込み全部に効き続ける。
 */
function usable(verdict: Verdict | undefined, known: Set<string>): verdict is Verdict {
  return verdict !== undefined && verdict.status !== 'unresolved' && known.has(verdict.categoryId);
}

function knownIds(categories: Category[]): Set<string> {
  return new Set(categories.filter((category) => !category.archived).map((category) => category.id));
}

/**
 * レシートの品目にカテゴリを当てる。順番は、人が覚えさせたカテゴリ（品目のルール）、
 * 判定（Jev）、OCR の関数がキーワード表で付けた答え。
 *
 * 覚えさせた品目は判定に聞かない。人が決めた答えを上書きさせないためと、聞く数を減らすため。
 * 判定が届かなかった品目は、キーワード表の答えをそのまま残す。
 */
export async function judgeReceiptItems(
  items: ReceiptItem[],
  storeName: string,
  categories: Category[],
  rules: CategoryRule[] = [],
): Promise<JudgedItems> {
  const known = knownIds(categories);
  // 覚えたカテゴリが今は使われていない（消した・統合した）ときは、覚えていないのと同じに扱う
  const ruledResult = applyItemRules(items, rules.filter((rule) => known.has(rule.categoryId)));
  const ruled = ruledResult.ruled;

  const verdicts = await judge({
    kind: 'item',
    categories,
    subjects: items.flatMap((item, index) =>
      ruled.has(index)
        ? []
        : [{ key: String(index), text: item.name, ...(storeName ? { context: storeName } : {}) }],
    ),
  });

  const warnings: string[] = [];
  const judged = ruledResult.items.map((item, index) => {
    if (ruled.has(index)) return item;
    const verdict = verdicts[String(index)];
    if (!usable(verdict, known)) return item;
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

  const known = knownIds(categories);
  const learned: CategoryRule[] = [];
  for (const key of keys) {
    const verdict = verdicts[key];
    if (usable(verdict, known) && verdict.status === 'accepted') {
      learned.push(learnRule(unknown.get(key) ?? key, verdict.categoryId));
    }
  }

  const judged = transactions.map((txn) => {
    if (!isUnclassified(txn)) return txn;
    const verdict = verdicts[normalizeMerchant(txn.rawMerchant)];
    if (!usable(verdict, known)) return txn;
    return {
      ...txn,
      splits: txn.splits.map((split) => ({ ...split, categoryId: verdict.categoryId })),
    };
  });

  return {
    transactions: judged,
    learned,
    judged: keys.filter((key) => usable(verdicts[key], known)).length,
  };
}

/** ルールに当たらなかった明細。内訳がまだ 1 行で、未分類のまま */
function isUnclassified(txn: Transaction): boolean {
  return txn.splits.length === 1 && txn.splits[0].categoryId === UNCATEGORIZED_ID;
}
