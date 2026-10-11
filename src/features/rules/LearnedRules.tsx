import { useMemo, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { activeCategories, categoryLabel, type CategoryRule } from '@kakeibo/core';
import { CategoryOptions } from '../../components/CategoryOptions';
import { useStore } from '../../api/store';
import { Card, EmptyState, Input, Select } from '../../components/ui/primitives';

type Kind = 'item' | 'merchant';

const KINDS: { kind: Kind; title: string; empty: string }[] = [
  {
    kind: 'item',
    title: '品目',
    empty: 'レシートの品目のカテゴリを選び直して保存すると、ここに並びます',
  },
  {
    kind: 'merchant',
    title: '店名',
    empty: '明細のカテゴリを直したり、取り込みで確信の高い判定が出たりすると、ここに並びます',
  },
];

/**
 * 覚えたカテゴリの一覧。品目名のルール（target: 'item'）と、店名のルールを分けて並べる。
 *
 * 覚えたものは次の読み込みや取り込みで黙って当たるので、覚え違い（「アプリポイント利用」を
 * 外食と覚えた、など）はここで見つけて直すか消す。初期搭載のルール（builtin）は出さない。
 *
 * 差し替えも削除も、保存済みの一覧からその 1 件を取り除く形で行う。ID で探さないのは、
 * 品目名を 40 文字で切って ID にしていた頃のルールが、同じ ID で並んでいることがあるため。
 */
export function LearnedRules() {
  const { snapshot, saveRules } = useStore();
  const [query, setQuery] = useState('');
  const categories = activeCategories(snapshot.categories);
  const active = new Set(categories.map((category) => category.id));

  const groups = useMemo(() => {
    const needle = query.trim().normalize('NFKC').toUpperCase();
    const rules = snapshot.rules.filter((rule) => !rule.builtin);
    const visible = needle
      ? rules.filter(
          (rule) =>
            rule.pattern.normalize('NFKC').toUpperCase().includes(needle) ||
            categoryLabel(snapshot.categories, rule.categoryId).includes(query.trim()),
        )
      : rules;
    const byLabel = (a: CategoryRule, b: CategoryRule) =>
      categoryLabel(snapshot.categories, a.categoryId).localeCompare(categoryLabel(snapshot.categories, b.categoryId), 'ja') ||
      a.pattern.localeCompare(b.pattern, 'ja');
    return {
      item: visible.filter((rule) => rule.target === 'item').sort(byLabel),
      merchant: visible.filter((rule) => rule.target !== 'item').sort(byLabel),
      total: rules.length,
    };
  }, [snapshot.rules, snapshot.categories, query]);

  async function replace(target: CategoryRule, next: CategoryRule | undefined) {
    const rest = snapshot.rules.filter((rule) => rule !== target);
    await saveRules(next ? [...rest, next] : rest);
  }

  return (
    <Card title={`覚えたカテゴリ ${groups.total} 件`}>
      <p className="text-xs text-muted">
        直したカテゴリは、次から同じ品目・同じ店に自動で当たります。覚え違いはここで直すか消してください。
      </p>
      {groups.total > 0 && (
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="品目名・店名・カテゴリで絞り込む"
          aria-label="覚えたカテゴリを絞り込む"
          className="mt-3"
        />
      )}

      {KINDS.map(({ kind, title, empty }) => {
        const rules = groups[kind];
        return (
          <section key={kind} className="mt-4">
            <h3 className="text-xs font-semibold text-ink-2">
              {title} {rules.length} 件
            </h3>
            {rules.length === 0 ? (
              query ? (
                <p className="mt-1 text-sm text-muted">当てはまるものがありません</p>
              ) : (
                <EmptyState title={`覚えた${title}はまだありません`}>{empty}</EmptyState>
              )
            ) : (
              <ul className="mt-1 divide-y divide-grid">
                {rules.map((rule, index) => (
                  <li key={`${rule.id}-${index}`} className="flex items-center gap-2 py-1.5">
                    <span className="min-w-0 flex-1 truncate text-sm text-ink" title={rule.pattern}>
                      {rule.pattern}
                    </span>
                    <Select
                      value={rule.categoryId}
                      onChange={(event) => void replace(rule, { ...rule, categoryId: event.target.value })}
                      className="w-32 min-w-0 shrink-0"
                      aria-label={`${rule.pattern} のカテゴリ`}
                    >
                      {/* 消したカテゴリを指したままのルールは、そのことが見えるように選択肢に残す */}
                      {!active.has(rule.categoryId) && <option value={rule.categoryId}>（使われていないカテゴリ）</option>}
                      <CategoryOptions categories={categories} />
                    </Select>
                    <button
                      type="button"
                      onClick={() => {
                        if (window.confirm(`「${rule.pattern}」を忘れますか`)) void replace(rule, undefined);
                      }}
                      className="shrink-0 rounded-md p-1.5 text-ink-2 hover:bg-plane"
                      aria-label={`${rule.pattern} を忘れる`}
                    >
                      <Trash2 size={15} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </Card>
  );
}
