import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import {
  TRANSFER_ID,
  UNCATEGORIZED_ID,
  activeCategories,
  aggregateMonth,
  canAdopt,
  carryOverBudget,
  childCategories,
  formatYen,
  mergeCategoryInSplits,
  topLevelCategories,
  type Budget,
  type Category,
} from '@kakeibo/core';
import { useStore } from '../../api/store';
import { Button, Card, Field, Input, Select } from '../../components/ui/primitives';
import { MonthPicker } from '../../components/ui/MonthPicker';
import { currentMonth, formatMonth, shiftMonth, todayIso } from '../../lib/month';

/**
 * カテゴリは最初の数か月で何度も作り直す前提。だから改名と統合を最初から入れてある。
 * 統合すると過去の明細の内訳も付け替わるので、集計が途中で分断されない。
 */
export function CategoriesPage() {
  const { snapshot, saveCategories, saveBudget, saveTransactions } = useStore();
  const [month, setMonth] = useState(currentMonth());
  const [newLabel, setNewLabel] = useState('');
  const [newParentId, setNewParentId] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>();

  const budget = snapshot.budgets.find((item) => item.month === month);
  // 振替・チャージは支出ではなく、集計にも上限にも出てこない。
  // ここに並べると実績 0 のまま上限だけ入れられるし、統合すると過去のチャージが支出に戻る
  const categories = activeCategories(snapshot.categories).filter((category) => category.id !== TRANSFER_ID);

  /** 大カテゴリの下に小カテゴリを並べた順。上限を入れるのは大カテゴリの行だけ */
  const rows = useMemo(() => {
    const ordered: { category: Category; child: boolean }[] = [];
    for (const parent of topLevelCategories(snapshot.categories)) {
      if (parent.id === TRANSFER_ID) continue;
      ordered.push({ category: parent, child: false });
      for (const child of childCategories(snapshot.categories, parent.id)) ordered.push({ category: child, child: true });
    }
    return ordered;
  }, [snapshot.categories]);

  const parentOptions = useMemo(
    () => topLevelCategories(snapshot.categories).filter((category) => category.id !== TRANSFER_ID && category.id !== UNCATEGORIZED_ID),
    [snapshot.categories],
  );

  const summary = useMemo(
    () =>
      aggregateMonth({
        month,
        transactions: snapshot.transactions,
        categories: snapshot.categories,
        budget,
        today: todayIso(),
      }),
    [month, snapshot, budget],
  );

  async function setLimit(categoryId: string, value: number) {
    const next: Budget = { month, limits: { ...(budget?.limits ?? {}) } };
    if (value > 0) next.limits[categoryId] = value;
    else delete next.limits[categoryId];
    await saveBudget(next);
  }

  async function rename(categoryId: string, label: string) {
    await saveCategories(snapshot.categories.map((item) => (item.id === categoryId ? { ...item, label } : item)));
  }

  async function add() {
    const label = newLabel.trim();
    if (!label) return;
    const id = `c-${Date.now().toString(36)}`;
    const order = Math.max(0, ...snapshot.categories.filter((item) => item.id !== UNCATEGORIZED_ID).map((item) => item.order)) + 1;
    const parentId = parentOptions.some((item) => item.id === newParentId) ? newParentId : '';
    await saveCategories([...snapshot.categories, { id, label, order, ...(parentId ? { parentId } : {}) }]);
    setNewLabel('');
  }

  /**
   * カテゴリを小カテゴリにする、または大カテゴリに戻す。
   * 置ける場所かどうかは core の canAdopt に聞く（3 段目や循環を作らせない）。
   */
  async function reparent(categoryId: string, parentId: string) {
    if (parentId !== '' && !canAdopt(snapshot.categories, categoryId, parentId)) {
      setMessage('そのカテゴリの下には置けません。小カテゴリの下に小カテゴリは作れません。');
      return;
    }
    await saveCategories(
      snapshot.categories.map((item) => {
        if (item.id !== categoryId) return item;
        const { parentId: _current, ...rest } = item;
        return parentId ? { ...rest, parentId } : rest;
      }),
    );
  }

  async function merge(fromId: string, toId: string) {
    if (fromId === toId) return;
    const fromLabel = snapshot.categories.find((item) => item.id === fromId)?.label ?? fromId;
    const toLabel = snapshot.categories.find((item) => item.id === toId)?.label ?? toId;
    if (!window.confirm(`${fromLabel} を ${toLabel} に寄せます。過去の明細の内訳も付け替わります。`)) return;

    setBusy(true);
    try {
      const moved = mergeCategoryInSplits(snapshot.transactions, fromId, toId);
      const changed = moved.filter((txn, index) => txn !== snapshot.transactions[index]);
      if (changed.length > 0) await saveTransactions(changed);

      /**
       * 小カテゴリを持っているカテゴリを寄せたら、子も一緒に連れていく。
       * 置いていくと、寄せたはずの中身が別の行として残る。
       * 寄せ先が小カテゴリだったときは 3 段目になってしまうので、子は大カテゴリに戻す。
       */
      const orphans = childCategories(snapshot.categories, fromId);
      const nextParentId = orphans.length > 0 && canAdopt(snapshot.categories, orphans[0].id, toId) ? toId : undefined;

      await saveCategories(
        snapshot.categories.map((item) => {
          if (item.id === fromId) return { ...item, archived: true };
          if (item.parentId !== fromId) return item;
          const { parentId: _current, ...rest } = item;
          return nextParentId ? { ...rest, parentId: nextParentId } : rest;
        }),
      );
      setMessage(`${changed.length} 件の明細を付け替えました。`);
    } finally {
      setBusy(false);
    }
  }

  async function copyPreviousLimits() {
    const previous = snapshot.budgets.find((item) => item.month === shiftMonth(month, -1));
    if (!previous) {
      setMessage('前の月の上限が見つかりません。');
      return;
    }
    await saveBudget(carryOverBudget(previous, month));
    setMessage(`${formatMonth(shiftMonth(month, -1))} の上限を持ってきました。`);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-ink">カテゴリと上限</h2>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => void copyPreviousLimits()}>
            前月の上限をコピー
          </Button>
          <MonthPicker month={month} onChange={setMonth} />
        </div>
      </div>

      {message && <p className="rounded-lg bg-plane px-3 py-2 text-sm text-ink">{message}</p>}

      <Card
        title={`${formatMonth(month)} の上限`}
        action={<span className="tnum text-sm text-ink-2">合計 {formatYen(summary.limitTotal)}</span>}
      >
        <ul className="divide-y divide-grid">
          {rows.map(({ category, child }) => {
            // 小カテゴリの実績は、親の行の children に入っている
            const row = summary.categories.find((item) => item.categoryId === (child ? category.parentId : category.id));
            const actual = child ? row?.children?.find((item) => item.categoryId === category.id)?.actual ?? 0 : row?.actual ?? 0;

            return (
              <li key={category.id} className={`flex flex-wrap items-center gap-2 py-2 ${child ? 'pl-4 sm:pl-6' : ''}`}>
                <Input
                  value={category.label}
                  onChange={(event) => void rename(category.id, event.target.value)}
                  className={child ? 'w-36 sm:w-44' : 'w-40 sm:w-48'}
                  aria-label="カテゴリ名"
                  disabled={category.id === UNCATEGORIZED_ID}
                />
                <span className="tnum w-24 text-right text-xs text-ink-2">実績 {formatYen(actual)}</span>
                {child ? (
                  // 上限は大カテゴリで持つ。小カテゴリは「食費の中で何に使ったか」を見るための分解
                  <span className="w-28 text-right text-xs text-muted">小カテゴリ</span>
                ) : (
                  <Input
                    type="number"
                    inputMode="numeric"
                    placeholder="上限なし"
                    defaultValue={budget?.limits?.[category.id] ?? ''}
                    onBlur={(event) => void setLimit(category.id, Math.round(Number(event.target.value) || 0))}
                    // sm: を付けないと Input 側の w-full に負けて、上限だけが行いっぱいに伸びる
                    className="tnum w-28 text-right sm:w-28"
                    aria-label={`${category.label} の上限`}
                  />
                )}
                {category.id !== UNCATEGORIZED_ID && (
                  <>
                    <ParentControl category={category} parents={parentOptions} disabled={busy} onChange={reparent} />
                    <MergeControl category={category} categories={categories} disabled={busy} onMerge={merge} />
                  </>
                )}
              </li>
            );
          })}
        </ul>

        <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-grid pt-3">
          <Field label="カテゴリを足す">
            <Input
              value={newLabel}
              onChange={(event) => setNewLabel(event.target.value)}
              placeholder="コンビニ、ふるさと納税 など"
              onKeyDown={(event) => {
                if (event.key === 'Enter') void add();
              }}
            />
          </Field>
          <Field label="どこに">
            <Select value={newParentId} onChange={(event) => setNewParentId(event.target.value)} aria-label="追加する先">
              <option value="">大カテゴリとして</option>
              {parentOptions.map((parent) => (
                <option key={parent.id} value={parent.id}>
                  {parent.label} の中に
                </option>
              ))}
            </Select>
          </Field>
          <Button variant="primary" onClick={() => void add()} disabled={!newLabel.trim()}>
            <Plus size={14} />
            追加
          </Button>
        </div>

        <p className="mt-2 text-xs text-muted">
          小カテゴリを作ると、レシートの品目は大カテゴリを決めたあとに小カテゴリまで判定します。
          上限と月末のレポートは大カテゴリのままです。
        </p>
      </Card>

      <Card title="使わなくなったカテゴリ">
        {snapshot.categories.filter((category) => category.archived).length === 0 ? (
          <p className="text-sm text-muted">まだありません。統合したカテゴリがここに入ります。</p>
        ) : (
          <ul className="space-y-2">
            {snapshot.categories
              .filter((category) => category.archived)
              .map((category) => (
                <li key={category.id} className="flex items-center justify-between gap-2">
                  <span className="text-sm text-ink-2">{category.label}</span>
                  <Button
                    size="sm"
                    onClick={() =>
                      void saveCategories(snapshot.categories.map((item) => (item.id === category.id ? { ...item, archived: false } : item)))
                    }
                  >
                    戻す
                  </Button>
                </li>
              ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

/**
 * そのカテゴリを誰の下に置くか。ここが「小カテゴリの仕組み」の入口で、
 * 大カテゴリとして立てるか、どれかの中に入れるかを 1 つの選択で決める。
 */
function ParentControl({
  category,
  parents,
  disabled,
  onChange,
}: {
  category: Category;
  parents: Category[];
  disabled: boolean;
  onChange: (categoryId: string, parentId: string) => Promise<void>;
}) {
  return (
    <Select
      value={category.parentId ?? ''}
      disabled={disabled}
      onChange={(event) => void onChange(category.id, event.target.value)}
      className="text-xs"
      aria-label={`${category.label} の親カテゴリ`}
    >
      <option value="">大カテゴリ</option>
      {parents
        .filter((parent) => parent.id !== category.id)
        .map((parent) => (
          <option key={parent.id} value={parent.id}>
            {parent.label} の中
          </option>
        ))}
    </Select>
  );
}

function MergeControl({
  category,
  categories,
  disabled,
  onMerge,
}: {
  category: Category;
  categories: Category[];
  disabled: boolean;
  onMerge: (fromId: string, toId: string) => Promise<void>;
}) {
  return (
    <Select
      value=""
      disabled={disabled}
      onChange={(event) => {
        if (event.target.value) void onMerge(category.id, event.target.value);
      }}
      className="text-xs"
      aria-label={`${category.label} を統合する先`}
    >
      <option value="">統合する…</option>
      {categories
        .filter((item) => item.id !== category.id)
        .map((item) => (
          <option key={item.id} value={item.id}>
            {item.label} に寄せる
          </option>
        ))}
    </Select>
  );
}
