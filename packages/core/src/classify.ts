import { TRANSFER_ID, UNCATEGORIZED_ID, childCategories, topLevelCategories } from './categories';
import type { Category } from './types';

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
  const criteria = Object.fromEntries(topLevelCategories(target.categories).map((category) => [category.id, describe(category)]));
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
  const known = new Set(categories.filter((category) => !category.archived).map((category) => category.id));

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
