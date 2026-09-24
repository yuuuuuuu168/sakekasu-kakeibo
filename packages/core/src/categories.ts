import type { Category } from './types';

export const UNCATEGORIZED_ID = 'uncategorized';

/**
 * 残高へのチャージを入れるカテゴリ。PayPay や Suica の残高に移しただけの金は支出ではないので、
 * カテゴリ別の実績と上限からは外す。支出として数えるのは残高側の利用明細のほう。
 * 普通のカテゴリとして持たせてあるのは、画面の付け替えとルール学習がそのまま使えるから。
 */
export const TRANSFER_ID = 'transfer';

/**
 * 初期カテゴリ。試行錯誤フェーズの出発点で、増やす前提。
 * 「酒」と「カフェ・嗜好品」を食費から独立させてあるのは、混ぜると何に使ったかが
 * 見えなくなる支出だから。要らなければ画面から食費へ統合する。
 */
export const SEED_CATEGORIES: Category[] = [
  { id: 'food', label: '食費', order: 1 },
  { id: 'eatout', label: '外食', order: 2 },
  { id: 'cafe', label: 'カフェ・嗜好品', order: 3 },
  { id: 'alcohol', label: '酒', order: 4 },
  { id: 'daily', label: '日用品', order: 5 },
  { id: 'apparel', label: '衣類・美容', order: 6 },
  { id: 'transport', label: '交通', order: 7 },
  { id: 'telecom', label: '通信', order: 8 },
  { id: 'housing', label: '住居・光熱', order: 9 },
  { id: 'medical', label: '医療', order: 10 },
  { id: 'hobby', label: '趣味・娯楽', order: 11 },
  { id: 'social', label: '交際費', order: 12 },
  { id: 'subscription', label: 'サブスク', order: 13 },
  { id: TRANSFER_ID, label: '振替・チャージ', order: 90 },
  { id: UNCATEGORIZED_ID, label: '未分類', order: 99 },
];

export function categoryLabel(categories: Category[], id: string): string {
  return categories.find((category) => category.id === id)?.label ?? id;
}

export function activeCategories(categories: Category[]): Category[] {
  return categories.filter((category) => !category.archived).sort((a, b) => a.order - b.order);
}

/**
 * 親をたどる回数の上限。カテゴリは 2 段までのつもりだが、保存済みのデータが
 * その形をしている保証は無い（親を消した、循環させた、孫を作った）。
 * 集計が落ちたり額が消えたりする方が困るので、番犬を置いて必ず止める。
 */
const MAX_DEPTH = 8;

/** 小カテゴリを吊れないカテゴリ。支出として数えない入れ物なので、分解する意味が無い */
const NO_CHILDREN = new Set([TRANSFER_ID, UNCATEGORIZED_ID]);

/**
 * その ID を上限とレポートで数える先。小カテゴリなら親の ID、大カテゴリなら自分の ID。
 * 親が見つからない、循環している、階層が深すぎる、といった壊れた形では途中で止めて
 * たどれたところを返す。返り値が必ず存在する ID になるとは限らない（消えたカテゴリの
 * 内訳がそのまま残ることがある）が、額が宙に浮くことは無い。
 */
export function rootCategoryId(categories: Category[], id: string): string {
  return rootIn(new Map(categories.map((category) => [category.id, category])), id);
}

function rootIn(byId: Map<string, Category>, id: string): string {
  let current = byId.get(id);
  if (!current) return id;
  const seen = new Set<string>([id]);

  for (let depth = 0; current.parentId && depth < MAX_DEPTH; depth += 1) {
    if (seen.has(current.parentId)) break;
    const parent = byId.get(current.parentId);
    // 親を統合して使わなくなったときは、子をそのまま大カテゴリとして立てる。
    // 消えた親に寄せると、集計の行にも画面の一覧にも出てこないカテゴリができる
    if (!parent || parent.archived) break;
    seen.add(parent.id);
    current = parent;
  }
  return current.id;
}

/** 大カテゴリだけを並べる。上限を入れる単位でもある */
export function topLevelCategories(categories: Category[]): Category[] {
  const byId = new Map(categories.map((category) => [category.id, category]));
  return activeCategories(categories).filter((category) => rootIn(byId, category.id) === category.id);
}

/** ある大カテゴリの小カテゴリ。孫は含めない（2 段までの運用なので直下だけ見る） */
export function childCategories(categories: Category[], parentId: string): Category[] {
  return activeCategories(categories).filter((category) => category.parentId === parentId);
}

export function hasChildren(categories: Category[], parentId: string): boolean {
  return categories.some((category) => !category.archived && category.parentId === parentId);
}

/**
 * カテゴリ別の集計を大カテゴリの単位に寄せる。小カテゴリの額は親に足し込む。
 * 上限とレポートの粒度を大カテゴリに据えてあるので、集計の側で寄せる。
 */
export function rollUpTotals(totals: Map<string, number>, categories: Category[]): Map<string, number> {
  const byId = new Map(categories.map((category) => [category.id, category]));
  const rolled = new Map<string, number>();
  for (const [id, amount] of totals) {
    const root = rootIn(byId, id);
    rolled.set(root, (rolled.get(root) ?? 0) + amount);
  }
  return rolled;
}

/** 上限も同じように寄せる。小カテゴリに上限が残っていても、どの行にも紐付かない額にしない */
export function rollUpLimits(limits: Record<string, number>, categories: Category[]): Record<string, number> {
  const byId = new Map(categories.map((category) => [category.id, category]));
  const rolled: Record<string, number> = {};
  for (const [id, limit] of Object.entries(limits)) {
    const root = rootIn(byId, id);
    rolled[root] = (rolled[root] ?? 0) + limit;
  }
  return rolled;
}

/**
 * その親の下に置いてよいかを確かめる。画面から壊れた形を作らせないための門。
 * 断るのは、自分自身、既に小カテゴリになっている相手（3 段目になる）、
 * 小カテゴリを抱えている自分（その子が孫になる）、未分類と振替、存在しない ID。
 * 親は必ず大カテゴリ、子は必ず子を持たない、という 2 つを守れば循環も起きない。
 */
export function canAdopt(categories: Category[], childId: string, parentId: string): boolean {
  if (childId === parentId) return false;
  if (NO_CHILDREN.has(parentId) || NO_CHILDREN.has(childId)) return false;

  const byId = new Map(categories.map((category) => [category.id, category]));
  const parent = byId.get(parentId);
  if (!parent || parent.archived || !byId.has(childId)) return false;
  if (parent.parentId) return false;

  return !hasChildren(categories, childId);
}

/**
 * カテゴリの統合。from を to に寄せ、明細の内訳も付け替える。
 * 統合後に同じカテゴリの内訳が 2 行並ぶことがあるので、まとめる。
 */
export function mergeCategoryInSplits<T extends { splits: { categoryId: string; amount: number; id: string; name?: string; origin: string }[] }>(
  transactions: T[],
  fromId: string,
  toId: string,
): T[] {
  return transactions.map((txn) => {
    if (!txn.splits.some((split) => split.categoryId === fromId)) return txn;
    const moved = txn.splits.map((split) =>
      split.categoryId === fromId ? { ...split, categoryId: toId } : split,
    );
    return { ...txn, splits: coalesce(moved) };
  });
}

function coalesce<S extends { categoryId: string; amount: number; id: string; name?: string }>(splits: S[]): S[] {
  // 品目名が付いている内訳（レシート由来）は何を買ったかの情報なので、まとめない
  const named = splits.filter((split) => split.name);
  const unnamed = splits.filter((split) => !split.name);
  const byCategory = new Map<string, S>();
  for (const split of unnamed) {
    const found = byCategory.get(split.categoryId);
    if (found) {
      byCategory.set(split.categoryId, { ...found, amount: found.amount + split.amount });
    } else {
      byCategory.set(split.categoryId, split);
    }
  }
  return [...named, ...byCategory.values()];
}
