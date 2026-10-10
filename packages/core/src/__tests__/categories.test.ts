import { describe, expect, it } from 'vitest';
import {
  DISCOUNT_ID,
  SEED_CATEGORIES,
  TRANSFER_ID,
  UNCATEGORIZED_ID,
  canAdopt,
  childCategories,
  hasChildren,
  rollUpLimits,
  rollUpTotals,
  rootCategoryId,
  topLevelCategories,
  withLaterSeeds,
} from '../categories';
import type { Category } from '../types';

/** 小カテゴリを持たない大カテゴリだけの形。初期カテゴリから切り離して、階層の扱いだけを見る */
const FLAT: Category[] = [
  { id: 'food', label: '食費', order: 1 },
  { id: 'cafe', label: 'カフェ', order: 2 },
  { id: 'daily', label: '日用品', order: 3 },
  { id: 'eatout', label: '外食', order: 4 },
  { id: TRANSFER_ID, label: '振替・チャージ', order: 90 },
  { id: UNCATEGORIZED_ID, label: '未分類', order: 99 },
];

/** 週末に足すつもりの小カテゴリを、テストの中で先に作ってみたもの */
const NESTED: Category[] = [
  ...FLAT,
  { id: 'rice', label: '米・パン', order: 101, parentId: 'food' },
  { id: 'deli', label: '惣菜', order: 102, parentId: 'food' },
  { id: 'paper', label: '紙もの', order: 103, parentId: 'daily' },
  { id: 'old-deli', label: '古い惣菜', order: 104, parentId: 'food', archived: true },
];

describe('rootCategoryId', () => {
  it('小カテゴリは親の ID を返す', () => {
    expect(rootCategoryId(NESTED, 'rice')).toBe('food');
    expect(rootCategoryId(NESTED, 'paper')).toBe('daily');
  });

  it('大カテゴリは自分の ID を返す', () => {
    expect(rootCategoryId(NESTED, 'food')).toBe('food');
  });

  it('消えたカテゴリの ID はそのまま返す', () => {
    expect(rootCategoryId(NESTED, 'gone')).toBe('gone');
  });

  it('親が消えていたら自分で止まる', () => {
    const orphan: Category[] = [{ id: 'orphan', label: '孤児', order: 1, parentId: 'missing' }];
    expect(rootCategoryId(orphan, 'orphan')).toBe('orphan');
  });

  it('孫まで作ってあっても一番上まで登る', () => {
    const deep: Category[] = [...NESTED, { id: 'koshihikari', label: 'コシヒカリ', order: 105, parentId: 'rice' }];
    expect(rootCategoryId(deep, 'koshihikari')).toBe('food');
  });

  it('親を統合して使わなくなったら、子は大カテゴリとして立つ', () => {
    const merged: Category[] = NESTED.map((category) => (category.id === 'food' ? { ...category, archived: true } : category));
    expect(rootCategoryId(merged, 'rice')).toBe('rice');
    expect(topLevelCategories(merged).map((category) => category.id)).toContain('rice');
  });

  it('循環していても止まる', () => {
    const cycle: Category[] = [
      { id: 'a', label: 'A', order: 1, parentId: 'b' },
      { id: 'b', label: 'B', order: 2, parentId: 'a' },
    ];
    expect(['a', 'b']).toContain(rootCategoryId(cycle, 'a'));
  });
});

describe('topLevelCategories / childCategories', () => {
  it('大カテゴリだけを並べる', () => {
    const ids = topLevelCategories(NESTED).map((category) => category.id);
    expect(ids).toContain('food');
    expect(ids).not.toContain('rice');
    expect(ids).not.toContain('paper');
  });

  it('小カテゴリを order の順に返す。使わなくなったものは外す', () => {
    expect(childCategories(NESTED, 'food').map((category) => category.id)).toEqual(['rice', 'deli']);
    expect(hasChildren(NESTED, 'food')).toBe(true);
    expect(hasChildren(NESTED, 'cafe')).toBe(false);
  });
});

describe('rollUpTotals / rollUpLimits', () => {
  it('小カテゴリの実績を親に足し込む', () => {
    const totals = new Map([
      ['rice', 800],
      ['deli', 400],
      ['cafe', 620],
    ]);
    const rolled = rollUpTotals(totals, NESTED);
    expect(rolled.get('food')).toBe(1200);
    expect(rolled.get('cafe')).toBe(620);
    expect(rolled.has('rice')).toBe(false);
  });

  it('大カテゴリに直接付いた実績と小カテゴリの実績は合算する', () => {
    const rolled = rollUpTotals(new Map([['food', 500], ['rice', 300]]), NESTED);
    expect(rolled.get('food')).toBe(800);
  });

  it('小カテゴリに上限が残っていても額を落とさない', () => {
    const rolled = rollUpLimits({ food: 40_000, rice: 5_000, cafe: 3_000 }, NESTED);
    expect(rolled.food).toBe(45_000);
    expect(rolled.rice).toBeUndefined();
    expect(rolled.cafe).toBe(3_000);
  });
});

describe('canAdopt', () => {
  it('大カテゴリの下に普通のカテゴリを置ける', () => {
    expect(canAdopt(FLAT, 'eatout', 'food')).toBe(true);
  });

  it('自分自身の下には置けない', () => {
    expect(canAdopt(FLAT, 'food', 'food')).toBe(false);
  });

  it('未分類と振替は親にも子にもしない', () => {
    expect(canAdopt(FLAT, 'food', UNCATEGORIZED_ID)).toBe(false);
    expect(canAdopt(FLAT, 'food', TRANSFER_ID)).toBe(false);
    expect(canAdopt(FLAT, UNCATEGORIZED_ID, 'food')).toBe(false);
  });

  it('小カテゴリの下には置けない（3 段目になる）', () => {
    expect(canAdopt(NESTED, 'cafe', 'rice')).toBe(false);
  });

  it('小カテゴリを抱えているカテゴリは子にできない（孫ができる）', () => {
    expect(canAdopt(NESTED, 'food', 'daily')).toBe(false);
  });

  it('使わなくなったカテゴリの下には置けない', () => {
    const merged: Category[] = FLAT.map((category) => (category.id === 'food' ? { ...category, archived: true } : category));
    expect(canAdopt(merged, 'eatout', 'food')).toBe(false);
  });

  it('知らない ID は断る', () => {
    expect(canAdopt(FLAT, 'food', 'nope')).toBe(false);
    expect(canAdopt(FLAT, 'nope', 'food')).toBe(false);
  });
});

describe('SEED_CATEGORIES', () => {
  const byId = new Map(SEED_CATEGORIES.map((category) => [category.id, category]));

  it('ID が重ならない', () => {
    expect(byId.size).toBe(SEED_CATEGORIES.length);
  });

  it('大カテゴリは支出 13 個と、値引き・振替・未分類', () => {
    const top = topLevelCategories(SEED_CATEGORIES).map((category) => category.label);
    expect(top).toHaveLength(16);
    expect(top.slice(-3)).toEqual(['値引き', '振替・チャージ', '未分類']);
    expect(top).toContain('推し活');
    expect(top).not.toContain('サブスク');
  });

  it('小カテゴリは 2 段までで、親は必ず大カテゴリ', () => {
    const children = SEED_CATEGORIES.filter((category) => category.parentId);
    expect(children).toHaveLength(46);
    for (const child of children) {
      const parent = byId.get(child.parentId ?? '');
      expect(parent, child.id).toBeDefined();
      expect(parent?.parentId, child.id).toBeUndefined();
      expect(child.id.startsWith(`${parent?.id}-`), child.id).toBe(true);
    }
  });

  it('振替と未分類には小カテゴリを吊らない', () => {
    expect(hasChildren(SEED_CATEGORIES, TRANSFER_ID)).toBe(false);
    expect(hasChildren(SEED_CATEGORIES, UNCATEGORIZED_ID)).toBe(false);
  });

  it('小カテゴリは親のすぐ後ろに並ぶ', () => {
    for (const parent of topLevelCategories(SEED_CATEGORIES)) {
      for (const child of childCategories(SEED_CATEGORIES, parent.id)) {
        expect(child.order).toBeGreaterThan(parent.order);
        expect(child.order).toBeLessThan(parent.order + 100);
      }
    }
  });
});

describe('withLaterSeeds', () => {
  const saved: Category[] = [
    { id: 'food', label: '食費', order: 100 },
    { id: UNCATEGORIZED_ID, label: '未分類', order: 9900 },
  ];

  it('使い始めた後に足した値引きを、保存済みの一覧に補う', () => {
    const filled = withLaterSeeds(saved);
    expect(filled.slice(0, 2)).toEqual(saved);
    expect(filled.find((category) => category.id === DISCOUNT_ID)?.label).toBe('値引き');
  });

  it('改名や統合で残っている値引きは、そのまま使う', () => {
    const renamed = [...saved, { id: DISCOUNT_ID, label: '割引', order: 8900 }];
    expect(withLaterSeeds(renamed)).toBe(renamed);
    const merged = [...saved, { id: DISCOUNT_ID, label: '値引き', order: 8900, archived: true }];
    expect(withLaterSeeds(merged)).toBe(merged);
  });

  it('値引きには小カテゴリを吊れず、値引きを小カテゴリにもできない', () => {
    expect(canAdopt(SEED_CATEGORIES, 'food-cafe', DISCOUNT_ID)).toBe(false);
    expect(canAdopt(SEED_CATEGORIES, DISCOUNT_ID, 'food')).toBe(false);
  });
});
