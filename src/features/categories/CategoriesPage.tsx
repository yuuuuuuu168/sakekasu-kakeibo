import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import {
  TRANSFER_ID,
  UNCATEGORIZED_ID,
  activeCategories,
  aggregateMonth,
  carryOverBudget,
  formatYen,
  mergeCategoryInSplits,
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
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>();

  const budget = snapshot.budgets.find((item) => item.month === month);
  // 振替・チャージは支出ではなく、集計にも上限にも出てこない。
  // ここに並べると実績 0 のまま上限だけ入れられるし、統合すると過去のチャージが支出に戻る
  const categories = activeCategories(snapshot.categories).filter((category) => category.id !== TRANSFER_ID);

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
    await saveCategories([...snapshot.categories, { id, label, order }]);
    setNewLabel('');
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
      await saveCategories(snapshot.categories.map((item) => (item.id === fromId ? { ...item, archived: true } : item)));
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
          {categories.map((category) => {
            const row = summary.categories.find((item) => item.categoryId === category.id);
            return (
              <li key={category.id} className="flex flex-wrap items-center gap-2 py-2">
                <Input
                  value={category.label}
                  onChange={(event) => void rename(category.id, event.target.value)}
                  className="w-40 sm:w-48"
                  aria-label="カテゴリ名"
                  disabled={category.id === UNCATEGORIZED_ID}
                />
                <span className="tnum w-24 text-right text-xs text-ink-2">実績 {formatYen(row?.actual ?? 0)}</span>
                <Input
                  type="number"
                  inputMode="numeric"
                  placeholder="上限なし"
                  defaultValue={budget?.limits?.[category.id] ?? ''}
                  onBlur={(event) => void setLimit(category.id, Math.round(Number(event.target.value) || 0))}
                  className="tnum w-28 text-right"
                  aria-label={`${category.label} の上限`}
                />
                {category.id !== UNCATEGORIZED_ID && (
                  <MergeControl category={category} categories={categories} disabled={busy} onMerge={merge} />
                )}
              </li>
            );
          })}
        </ul>

        <div className="mt-4 flex items-end gap-2 border-t border-grid pt-3">
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
          <Button variant="primary" onClick={() => void add()} disabled={!newLabel.trim()}>
            <Plus size={14} />
            追加
          </Button>
        </div>
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
