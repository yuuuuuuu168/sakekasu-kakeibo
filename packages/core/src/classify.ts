import { DISCOUNT_ID, TRANSFER_ID, UNCATEGORIZED_ID, categoryLabel, childCategories, topLevelCategories } from './categories';
import { normalizeMerchant } from './merchant';
import { applyItemRules, learnRule } from './rules';
import type { Category, CategoryRule, ReceiptItem, Transaction } from './types';

/**
 * カテゴリ判定を 2 段に分ける。まず大カテゴリを選び、その中の小カテゴリを選ぶ。
 *
 * 1 段で全カテゴリを並べても選べはするが、小カテゴリまで足すと選択肢が数十になり、
 * 「食費か日用品か」という粗い判断と「米か惣菜か」という細かい判断が同じ 1 回に混ざる。
 * 分けておくと、大カテゴリだけ当たって小カテゴリが分からなかったとき、
 * 大カテゴリまでの結論を残せる（`decideVerdict` が親に落とす）。
 *
 * ここには判定の材料と採否だけを置き、モデルの呼び出しは Lambda に持たせている。
 * 画面（ローカルモード）でも同じ採否を使えるようにするため、外部への依存を入れない。
 */

/** 小カテゴリのどれにも当てはまらない、を表すラベル。カテゴリ ID と衝突しない形にしてある */
export const NONE_OF_CHILDREN = '__none__';

/**
 * 確信度の線引き。Jev の confidence は校正されている（高い方が実際に当たる）という
 * 前提の上に立っているので、当たり外れを見ながらこの 2 つを動かすのが調整の入口になる。
 */
export const ACCEPT_CONFIDENCE = 0.8;
export const REVIEW_CONFIDENCE = 0.5;

export type ClassifyKind = 'item' | 'merchant';

export type ClassifySubject = {
  /** 答えを引き当てる名前。呼び出し側が品目や店舗と対応づけるのに使う */
  key: string;
  /** 判定させる文字列。レシートの品目名、または明細の店舗名 */
  text: string;
  /** 判断の手がかりになる文脈。品目ならレシートの店舗名 */
  context?: string;
};

export type ClassifyTarget = {
  kind: ClassifyKind;
  subjects: ClassifySubject[];
  categories: Category[];
};

/** モデルに投げる 1 問。Jev の choice() に渡す材料 */
export type ChoiceSpec = {
  name: string;
  instructions: string;
  /** ラベル（カテゴリ ID）→ 説明（カテゴリ名）。返ってくるのはラベルの側 */
  criteria: Record<string, string>;
};

/** choice の答えのうち、判定に使う分だけ */
export type ChoiceAnswer = {
  choice: string;
  confidence: number;
};

export type VerdictStatus =
  /** そのまま使う */
  | 'accepted'
  /** 使うが、人に見てもらう */
  | 'review'
  /** 判断できなかった。未分類に落とす */
  | 'unresolved';

export type Verdict = {
  categoryId: string;
  /** 大カテゴリと小カテゴリの両方を通した確信度 */
  confidence: number;
  status: VerdictStatus;
  /** 小カテゴリまで決まったとき、その親。画面の表示に使う */
  parentId?: string;
};

/**
 * 判定の結論を件数にまとめる。ログに残して、確信度の線（ACCEPT / REVIEW）が
 * 実際にどう効いているかを見るためのもの。品目名や店舗名は入れない。
 */
export function summarizeVerdicts(verdicts: Record<string, Verdict>): {
  件数: number;
  そのまま入れた: number;
  人に見せた: number;
  捨てた: number;
  小カテゴリまで: number;
} {
  const all = Object.values(verdicts);
  return {
    件数: all.length,
    そのまま入れた: all.filter((verdict) => verdict.status === 'accepted').length,
    人に見せた: all.filter((verdict) => verdict.status === 'review').length,
    捨てた: all.filter((verdict) => verdict.status === 'unresolved').length,
    小カテゴリまで: all.filter((verdict) => verdict.parentId !== undefined).length,
  };
}

/**
 * カテゴリの説明。ラベル（ID）だけでは意味が伝わらない 2 つに言葉を足す。
 * 利用者が付けたカテゴリ名はそのまま説明に使う。名前がその人にとっての定義なので、
 * こちらで言い換えない。
 */
function describe(category: Category): string {
  if (category.id === UNCATEGORIZED_ID) return `${category.label}（上のどれにも当てはまらない、または読み取れない）`;
  if (category.id === TRANSFER_ID) return `${category.label}（PayPay や Suica の残高への入金。買い物ではない）`;
  return category.label;
}

function ask(kind: ClassifyKind, subject: ClassifySubject): string {
  if (kind === 'merchant') return `「${subject.text}」での支払いは、家計のどの費目になりますか。`;
  const where = subject.context ? `${subject.context} で買った` : '';
  return `${where}「${subject.text}」は、家計のどの費目になりますか。`;
}

/** 1 段目。大カテゴリを選ばせる */
export function parentChoiceSpecs(target: ClassifyTarget): ChoiceSpec[] {
  // 値引きは選ばせない。負の金額の行は聞く前に値引きと決めてあり、正の金額の品目や店が値引きになることは無い
  const criteria = Object.fromEntries(
    topLevelCategories(target.categories)
      .filter((category) => category.id !== DISCOUNT_ID)
      .map((category) => [category.id, describe(category)]),
  );
  if (Object.keys(criteria).length < 2) return [];

  return target.subjects.map((subject) => ({
    name: subject.key,
    instructions: ask(target.kind, subject),
    criteria,
  }));
}

/**
 * 2 段目。1 段目で決まった大カテゴリの小カテゴリを選ばせる。
 * 小カテゴリを持たない大カテゴリ、確信が低すぎた大カテゴリは聞かない（聞く意味が無いので）。
 * 「どれにも当てはまらない」を必ず混ぜてあるのは、Choice が必ず 1 つ返すため。
 * 出口を用意しないと、米でも惣菜でもないものがどちらかに押し込まれる。
 */
export function childChoiceSpecs(target: ClassifyTarget, parentAnswers: Record<string, ChoiceAnswer | undefined>): ChoiceSpec[] {
  const specs: ChoiceSpec[] = [];

  for (const subject of target.subjects) {
    const parent = parentAnswers[subject.key];
    if (!parent || parent.confidence < REVIEW_CONFIDENCE) continue;

    const children = childCategories(target.categories, parent.choice);
    if (children.length === 0) continue;

    const criteria: Record<string, string> = Object.fromEntries(children.map((category) => [category.id, describe(category)]));
    criteria[NONE_OF_CHILDREN] = 'この中のどれにも当てはまらない';

    specs.push({
      name: subject.key,
      instructions: ask(target.kind, subject),
      criteria,
    });
  }

  return specs;
}

/**
 * 2 つの答えから結論を出す。
 *
 * 大カテゴリの確信が低ければ未分類にする。小カテゴリまで決まったときの確信度は
 * 2 つの積をとる。大カテゴリが外れていれば小カテゴリも外れているので、
 * 「小カテゴリが正しい」と言えるのは両方当たったときだけ。
 */
export function decideVerdict(
  categories: Category[],
  parent: ChoiceAnswer | undefined,
  child: ChoiceAnswer | undefined,
): Verdict {
  const known = knownCategoryIds(categories);

  // 未分類を選んだときは「置き場所が分からなかった」という答えなので、確信が高くても未解決として扱う。
  // 呼び出し側から見ると、ルールを学習させてはいけない・人に見せたい、という点で確信の低い答えと同じ
  if (
    !parent ||
    !known.has(parent.choice) ||
    parent.choice === UNCATEGORIZED_ID ||
    parent.confidence < REVIEW_CONFIDENCE
  ) {
    return { categoryId: UNCATEGORIZED_ID, confidence: parent?.confidence ?? 0, status: 'unresolved' };
  }

  // 小カテゴリの答えは、選んだ大カテゴリの直下にあるものだけ受け取る。
  // 明細の文字列はそのまま問いに入るので、答えが別の大カテゴリの子や未分類を指すことがあり、
  // それを通すと親子の食い違った結論がルールとして学習されてしまう
  const siblings = new Set(childCategories(categories, parent.choice).map((category) => category.id));
  const useChild =
    child !== undefined &&
    child.choice !== NONE_OF_CHILDREN &&
    siblings.has(child.choice) &&
    child.confidence >= REVIEW_CONFIDENCE;

  if (!useChild) {
    return { categoryId: parent.choice, confidence: parent.confidence, status: statusOf(parent.confidence) };
  }

  const confidence = parent.confidence * child.confidence;
  // 小カテゴリまで下りたぶん確信度は下がる。下がりすぎたら大カテゴリで止めておく方が正しい
  if (confidence < REVIEW_CONFIDENCE) {
    return { categoryId: parent.choice, confidence: parent.confidence, status: statusOf(parent.confidence) };
  }

  return { categoryId: child.choice, confidence, status: statusOf(confidence), parentId: parent.choice };
}

function statusOf(confidence: number): VerdictStatus {
  if (confidence >= ACCEPT_CONFIDENCE) return 'accepted';
  if (confidence >= REVIEW_CONFIDENCE) return 'review';
  return 'unresolved';
}

/** 全部まとめて結論にする。答えが 1 つも無ければ全部未分類になる */
export function decideVerdicts(
  target: ClassifyTarget,
  parentAnswers: Record<string, ChoiceAnswer | undefined>,
  childAnswers: Record<string, ChoiceAnswer | undefined>,
): Record<string, Verdict> {
  const verdicts: Record<string, Verdict> = {};
  for (const subject of target.subjects) {
    verdicts[subject.key] = decideVerdict(target.categories, parentAnswers[subject.key], childAnswers[subject.key]);
  }
  return verdicts;
}

/*
 * ここから下は、返ってきた答えを品目や明細に書き込む側の採否。
 * 判定の呼び出し（api.classify）は画面の src/api/classify.ts に残し、何を聞くか（plan）と
 * 答えをどう採るか（apply）をここに置く。Lambda から同じ採否が要るときに 2 回書かないため。
 */

/** 使っているカテゴリの ID。消した（archived）カテゴリは入れない */
export function knownCategoryIds(categories: Category[]): Set<string> {
  return new Set(categories.filter((category) => !category.archived).map((category) => category.id));
}

/**
 * 使える答えかどうかを確かめる。手元にあるカテゴリを指していない答えは捨てる。
 *
 * 同じ検査は判定の側（`decideVerdict`）でもしているが、こちらは受け取った ID を
 * 内訳とルールに書き込む側なので、書き込む直前にもう一度見る。画面が知らない
 * カテゴリが内訳に入ると、どの行にも出てこない額ができて、集計が静かに狂う。
 * ルールとして覚えてしまえば、以降の取り込み全部に効き続ける。
 */
export function usableVerdict(verdict: Verdict | undefined, known: Set<string>): verdict is Verdict {
  return verdict !== undefined && verdict.status !== 'unresolved' && known.has(verdict.categoryId);
}

export type ItemJudgement = {
  /** 判定に聞く分。空なら聞かなくてよい */
  target: ClassifyTarget;
  /** 覚えた品目のカテゴリを当てた後の品目 */
  items: ReceiptItem[];
  /** 判定に聞かない行（覚えた品目と値引き）の位置 */
  skipped: Set<number>;
};

/**
 * レシートの品目のうち、判定に聞く分を決める。順番は、人が覚えさせたカテゴリ（品目のルール）、
 * 判定（Jev）、OCR の関数がキーワード表で付けた答え。
 *
 * 覚えさせた品目は判定に聞かない。人が決めた答えを上書きさせないためと、聞く数を減らすため。
 * 負の金額の行は値引きなので聞かない（キーワード表の側で値引きに入っている）。
 * 「おにぎり 値引」を聞くと食費と答えが返り、値引きが品目の側に混ざる
 */
export function planItemJudgement(
  items: ReceiptItem[],
  storeName: string,
  categories: Category[],
  rules: CategoryRule[] = [],
): ItemJudgement {
  const known = knownCategoryIds(categories);
  // 覚えたカテゴリが今は使われていない（消した・統合した）ときは、覚えていないのと同じに扱う
  const ruled = applyItemRules(items, rules.filter((rule) => known.has(rule.categoryId)));
  const skipped = new Set([...ruled.ruled, ...items.flatMap((item, index) => (item.amount < 0 ? [index] : []))]);
  return {
    target: {
      kind: 'item',
      categories,
      subjects: items.flatMap((item, index) =>
        skipped.has(index) ? [] : [{ key: String(index), text: item.name, ...(storeName ? { context: storeName } : {}) }],
      ),
    },
    items: ruled.items,
    skipped,
  };
}

/**
 * 判定の答えを品目に当てる。答えが届かなかった品目は、キーワード表の答えをそのまま残す。
 * 確信が中くらいの答えは使うが、下書きの注意書きに混ぜる文を返す
 */
export function applyItemVerdicts(
  plan: ItemJudgement,
  verdicts: Record<string, Verdict>,
  categories: Category[],
): { items: ReceiptItem[]; warnings: string[] } {
  const known = knownCategoryIds(categories);
  const warnings: string[] = [];
  const items = plan.items.map((item, index) => {
    if (plan.skipped.has(index)) return item;
    const verdict = verdicts[String(index)];
    if (!usableVerdict(verdict, known)) return item;
    if (verdict.status === 'review') {
      warnings.push(`「${item.name}」は ${categoryLabel(categories, verdict.categoryId)} と見ましたが、確信は高くありません。`);
    }
    return { ...item, categoryId: verdict.categoryId };
  });
  return { items, warnings };
}

export type MerchantJudgement = {
  target: ClassifyTarget;
  /** 正規化した店舗名 → 判定に見せた元の店舗名 */
  names: Map<string, string>;
};

/** ルールに当たらなかった明細。内訳がまだ 1 行で、未分類のまま */
export function isUnclassified(txn: Transaction): boolean {
  return txn.splits.length === 1 && txn.splits[0].categoryId === UNCATEGORIZED_ID;
}

/**
 * 取り込んだ明細のうち、ルールに当たらなかった店を判定に聞く分にする。
 * 正規化した店舗名で 1 つにまとめ、表記が揺れただけの同じ店を 2 回聞かない
 */
export function planMerchantJudgement(transactions: Transaction[], categories: Category[]): MerchantJudgement {
  const names = new Map<string, string>();
  for (const txn of transactions) {
    if (!isUnclassified(txn)) continue;
    const key = normalizeMerchant(txn.rawMerchant);
    if (key === '' || names.has(key)) continue;
    names.set(key, txn.rawMerchant);
  }
  return {
    target: { kind: 'merchant', categories, subjects: [...names].map(([key, text]) => ({ key, text })) },
    names,
  };
}

/**
 * 店の判定の答えを明細に当てる。同じ店の行には全部同じ答えが効く。
 * 確信が高ければルールにして覚えるので、次の月の取り込みではルールが先に当たり、判定そのものを呼ばなくなる。
 * 確信が中くらいならカテゴリだけ入れて、ルールは作らない（間違いを固定しないため）。
 */
export function applyMerchantVerdicts(
  transactions: Transaction[],
  plan: MerchantJudgement,
  verdicts: Record<string, Verdict>,
  categories: Category[],
): { transactions: Transaction[]; learned: CategoryRule[]; judged: number } {
  const known = knownCategoryIds(categories);
  const keys = [...plan.names.keys()];

  const learned: CategoryRule[] = [];
  for (const key of keys) {
    const verdict = verdicts[key];
    if (usableVerdict(verdict, known) && verdict.status === 'accepted') {
      learned.push(learnRule(plan.names.get(key) ?? key, verdict.categoryId));
    }
  }

  const judged = transactions.map((txn) => {
    if (!isUnclassified(txn)) return txn;
    const verdict = verdicts[normalizeMerchant(txn.rawMerchant)];
    if (!usableVerdict(verdict, known)) return txn;
    return { ...txn, splits: txn.splits.map((split) => ({ ...split, categoryId: verdict.categoryId })) };
  });

  return {
    transactions: judged,
    learned,
    judged: keys.filter((key) => usableVerdict(verdicts[key], known)).length,
  };
}
