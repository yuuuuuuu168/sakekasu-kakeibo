import type { Category } from './types';

export const UNCATEGORIZED_ID = 'uncategorized';

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
  { id: UNCATEGORIZED_ID, label: '未分類', order: 99 },
];

export function categoryLabel(categories: Category[], id: string): string {
  return categories.find((category) => category.id === id)?.label ?? id;
}

export function activeCategories(categories: Category[]): Category[] {
  return categories.filter((category) => !category.archived).sort((a, b) => a.order - b.order);
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
