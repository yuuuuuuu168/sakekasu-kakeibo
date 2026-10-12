import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { SEED_CATEGORIES, learnItemRule, learnRule, type CategoryRule } from '@kakeibo/core';
import type { Snapshot } from '../../../api/types';

const store = vi.hoisted(() => ({
  snapshot: { categories: [], rules: [], budgets: [], transactions: [], receipts: [], mappings: [], recurring: [] } as Snapshot,
  saveRules: vi.fn(async (_rules: CategoryRule[]) => undefined),
}));

vi.mock('../../../api/store', () => ({ useStore: () => store }));

const { LearnedRules } = await import('../LearnedRules');

const POINT = learnItemRule('アプリポイント利用', 'food-eatout');
const COFFEE = learnItemRule('アイスGコーヒー', 'food-cafe');
const TULLYS = learnRule('タリーズコーヒー', 'food-cafe');
const BUILTIN: CategoryRule = { id: 'seed-1', pattern: 'セブン-イレブン', matchType: 'contains', categoryId: 'food', priority: 0, builtin: true };

function load(rules: CategoryRule[]) {
  store.snapshot = { ...store.snapshot, categories: SEED_CATEGORIES, rules };
}

describe('覚えたカテゴリの一覧', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    load([POINT, COFFEE, TULLYS, BUILTIN]);
  });

  it('品目と店名を分けて並べ、初期搭載のルールは出さない', () => {
    render(<LearnedRules />);
    expect(screen.getByText('覚えたカテゴリ 3 件')).toBeInTheDocument();
    expect(screen.getByText('品目 2 件')).toBeInTheDocument();
    expect(screen.getByText('店名 1 件')).toBeInTheDocument();
    expect(screen.queryByText('セブン-イレブン')).not.toBeInTheDocument();
  });

  it('忘れると、その 1 件だけを取り除いて保存する', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<LearnedRules />);
    fireEvent.click(screen.getByRole('button', { name: 'アプリポイント利用 を忘れる' }));
    expect(store.saveRules).toHaveBeenCalledWith([COFFEE, TULLYS, BUILTIN]);
  });

  it('カテゴリを選び直すと、そのルールのカテゴリだけを変える', () => {
    render(<LearnedRules />);
    fireEvent.change(screen.getByLabelText('アプリポイント利用 のカテゴリ'), { target: { value: 'daily' } });
    const saved = store.saveRules.mock.calls[0][0];
    expect(saved).toHaveLength(4);
    expect(saved.find((rule) => rule.pattern === POINT.pattern)?.categoryId).toBe('daily');
  });

  /* 40 文字で切った ID の頃のルールは、同じ ID で 2 件並ぶことがある。消すのは押した 1 件だけ */
  it('同じ ID のルールが 2 件あっても、押した方だけを消す', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const twin = { ...COFFEE, pattern: 'アイスGコーヒーL' };
    load([COFFEE, twin]);
    render(<LearnedRules />);
    fireEvent.click(screen.getByRole('button', { name: 'アイスGコーヒーL を忘れる' }));
    expect(store.saveRules).toHaveBeenCalledWith([COFFEE]);
  });

  it('品目名やカテゴリ名で絞り込める', () => {
    render(<LearnedRules />);
    fireEvent.change(screen.getByLabelText('覚えたカテゴリを絞り込む'), { target: { value: 'ポイント' } });
    const items = screen.getByText(/^品目 \d+ 件$/).closest('section')!;
    expect(within(items).getByText('アプリポイント利用')).toBeInTheDocument();
    expect(within(items).queryByText('アイスGコーヒー')).not.toBeInTheDocument();
  });

  it('何も覚えていなければ、そう書く', () => {
    load([BUILTIN]);
    render(<LearnedRules />);
    expect(screen.getByText('覚えた品目はまだありません')).toBeInTheDocument();
    expect(screen.getByText('覚えた店名はまだありません')).toBeInTheDocument();
  });
});
