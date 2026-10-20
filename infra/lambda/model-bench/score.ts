import { normalizeItemName, rootCategoryId, type Category, type Receipt, type Verdict } from '@kakeibo/core';
import type { Draft } from '../ocr-receipt/draft';

/**
 * モデルの答えを、保存済みのレシート（人が確かめて直した後のもの）と突き合わせて点を付ける。
 * 保存済みのレシートを正解にしているので、人が手で書き換えた品目名（略字を開いた、など）は
 * 印字どおりに読めていても外れに数えられる。点は「人が最後に残した形との一致率」として読む。
 *
 * ログに出すのは数だけ。品目名・金額・店名・日付は出さない。
 */

export type OcrScore = {
  /** 合計（通貨の最小単位）と通貨が一致した */
  total: boolean;
  date: boolean;
  /** 店名。空白と全角半角・大小の違いは見ない */
  store: boolean;
  currency: boolean;
  truthItems: number;
  draftItems: number;
  /** 品目名（正規化後）と金額の両方が合った品目の数 */
  exactItems: number;
  /** 金額だけで見て合った品目の数。名前の読みの差を除いた「拾えた行」の数 */
  amountItems: number;
  /** exactItems の F1（0〜1） */
  itemF1: number;
  /** amountItems の F1（0〜1） */
  amountF1: number;
  /** 品目の合計が読んだ合計と一致した（読み落とし・二重取りが無い目安） */
  balanced: boolean;
  /** 下書きの注意書きの数。人に「確かめて」と出した数 */
  warnings: number;
};

export function scoreOcr(truth: Receipt, draft: Draft): OcrScore {
  const truthCurrency = truth.currency ?? 'JPY';
  const draftCurrency = draft.currency ?? 'JPY';
  const currency = truthCurrency === draftCurrency;

  const truthItems = truth.items.map((item) => ({ name: normalizeItemName(item.name), amount: item.amount }));
  const draftItems = draft.items.map((item) => ({ name: normalizeItemName(item.name), amount: item.amount }));

  const exactItems = countMatches(truthItems, draftItems, (a, b) => a.name === b.name && a.amount === b.amount);
  const amountItems = countMatches(truthItems, draftItems, (a, b) => a.amount === b.amount);

  return {
    total: currency && draft.total === truth.total,
    date: draft.date === truth.date,
    store: normalizeItemName(draft.storeName) === normalizeItemName(truth.storeName),
    currency,
    truthItems: truthItems.length,
    draftItems: draftItems.length,
    exactItems,
    amountItems,
    itemF1: f1(exactItems, truthItems.length, draftItems.length),
    amountF1: f1(amountItems, truthItems.length, draftItems.length),
    balanced: draft.items.reduce((sum, item) => sum + item.amount, 0) === draft.total,
    warnings: draft.warnings.length,
  };
}

/** 多重集合として何組が合うか。片方の 1 つは相手の 1 つとしか組まない */
function countMatches<T>(truth: T[], draft: T[], same: (a: T, b: T) => boolean): number {
  const left = [...draft];
  let matched = 0;
  for (const item of truth) {
    const index = left.findIndex((candidate) => same(item, candidate));
    if (index < 0) continue;
    left.splice(index, 1);
    matched += 1;
  }
  return matched;
}

/** 正解 truth 件・答え answered 件のうち matched 件が合ったときの F1。どちらも 0 件なら 1 */
export function f1(matched: number, truth: number, answered: number): number {
  if (truth === 0 && answered === 0) return 1;
  if (truth === 0 || answered === 0) return 0;
  const precision = matched / answered;
  const recall = matched / truth;
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

export type ClassifyCase = {
  /** 正解のカテゴリ（保存済みのレシートの品目に付いているもの） */
  truth: string;
  /** 人が直して覚えさせた品目（品目のルールに当たる）。最も確かな正解 */
  ruled: boolean;
};

export type ClassifyScore = {
  subjects: number;
  /** カテゴリ（小カテゴリまで）が一致した */
  exact: number;
  /** 大カテゴリまでで一致した */
  root: number;
  /** ruled の品目の数と、そのうち一致した数 */
  ruled: number;
  ruledExact: number;
  accepted: number;
  review: number;
  unresolved: number;
  /** そのまま入れた（accepted）品目のうち一致した数。確信度の線の当たり具合 */
  acceptedExact: number;
};

export function scoreClassify(
  cases: Record<string, ClassifyCase>,
  verdicts: Record<string, Pick<Verdict, 'categoryId' | 'status'> | undefined>,
  categories: Category[],
): ClassifyScore {
  const score: ClassifyScore = {
    subjects: 0,
    exact: 0,
    root: 0,
    ruled: 0,
    ruledExact: 0,
    accepted: 0,
    review: 0,
    unresolved: 0,
    acceptedExact: 0,
  };
  for (const [key, expected] of Object.entries(cases)) {
    const verdict = verdicts[key];
    const answer = verdict?.categoryId;
    const status = verdict?.status ?? 'unresolved';
    const exact = answer === expected.truth;

    score.subjects += 1;
    if (exact) score.exact += 1;
    if (answer !== undefined && rootCategoryId(categories, answer) === rootCategoryId(categories, expected.truth)) score.root += 1;
    if (expected.ruled) {
      score.ruled += 1;
      if (exact) score.ruledExact += 1;
    }
    score[status] += 1;
    if (status === 'accepted' && exact) score.acceptedExact += 1;
  }
  return score;
}
