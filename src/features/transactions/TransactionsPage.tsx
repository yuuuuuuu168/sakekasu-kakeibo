import { useMemo, useState } from 'react';
import { Scissors, Trash2 } from 'lucide-react';
import {
  UNCATEGORIZED_ID,
  activeCategories,
  categoryLabel,
  formatYen,
  learnRule,
  transactionsOfMonth,
  type Transaction,
} from '@kakeibo/core';
import { useStore } from '../../api/store';
import { Badge, Card, EmptyState, Select } from '../../components/ui/primitives';
import { MonthPicker } from '../../components/ui/MonthPicker';
import { SplitDialog } from './SplitDialog';
import { currentMonth } from '../../lib/month';

export function TransactionsPage({ month: initialMonth, filter: initialFilter }: { month?: string; filter?: string }) {
  const { snapshot, saveTransaction, removeTransaction, saveRules } = useStore();
  const [month, setMonth] = useState(initialMonth ?? currentMonth());
  const [filter, setFilter] = useState(initialFilter ?? 'all');
  const [editing, setEditing] = useState<Transaction | undefined>();

  const categories = activeCategories(snapshot.categories);

  const rows = useMemo(() => {
    const monthly = transactionsOfMonth(snapshot.transactions, month).sort((a, b) => b.date.localeCompare(a.date));
    if (filter === 'all') return monthly;
    if (filter === 'needsDetail') return monthly.filter((txn) => txn.needsDetail);
    return monthly.filter((txn) => txn.splits.some((split) => split.categoryId === filter));
  }, [snapshot.transactions, month, filter]);

  const total = rows.reduce((sum, txn) => sum + txn.amount, 0);

  /** カテゴリを直したら、同じ店は今後も同じカテゴリになるようルールを増やす */
  async function recategorize(txn: Transaction, categoryId: string) {
    const updated: Transaction = {
      ...txn,
      splits: [{ id: `${txn.id}-1`, amount: txn.amount, categoryId, origin: 'manual' }],
      needsDetail: false,
    };
    await saveTransaction(updated);

    if (!txn.rawMerchant) return;
    const rule = learnRule(txn.rawMerchant, categoryId);
    const others = snapshot.rules.filter((item) => item.id !== rule.id);
    await saveRules([...others, rule]);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-ink">明細</h1>
        <div className="flex items-center gap-2">
          <Select value={filter} onChange={(event) => setFilter(event.target.value)}>
            <option value="all">すべて</option>
            <option value="needsDetail">内訳待ちだけ</option>
            <option value={UNCATEGORIZED_ID}>未分類だけ</option>
            {categories
              .filter((category) => category.id !== UNCATEGORIZED_ID)
              .map((category) => (
                <option key={category.id} value={category.id}>
                  {category.label}
                </option>
              ))}
          </Select>
          <MonthPicker month={month} onChange={setMonth} />
        </div>
      </div>

      <Card title={`${rows.length} 件`} action={<span className="tnum text-sm font-semibold text-ink">{formatYen(total)}</span>}>
        {rows.length === 0 ? (
          <EmptyState title="該当する明細がありません">
            <a href="#/import" className="text-accent">
              明細を取り込む
            </a>
          </EmptyState>
        ) : (
          <ul className="divide-y divide-grid">
            {rows.map((txn) => (
              <li key={txn.id} className="py-3">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="tnum text-xs text-muted">{txn.date.slice(5)}</span>
                      <span className="truncate text-sm font-medium text-ink">{txn.rawMerchant || '（店名なし）'}</span>
                      <span className="text-xs text-muted">{txn.sourceLabel}</span>
                      {txn.needsDetail && <Badge tone="accent">内訳待ち</Badge>}
                      {txn.receiptId && <Badge tone="good">レシートあり</Badge>}
                    </div>

                    {txn.splits.length > 1 ? (
                      <ul className="mt-1.5 space-y-0.5">
                        {txn.splits.map((split) => (
                          <li key={split.id} className="flex items-baseline gap-2 text-xs">
                            <span className="text-ink-2">{categoryLabel(snapshot.categories, split.categoryId)}</span>
                            {split.name && <span className="truncate text-muted">{split.name}</span>}
                            <span className="flex-1 border-b border-dotted border-grid" />
                            <span className="tnum text-ink-2">{formatYen(split.amount)}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <div className="mt-1.5">
                        <Select
                          value={txn.splits[0]?.categoryId ?? UNCATEGORIZED_ID}
                          onChange={(event) => void recategorize(txn, event.target.value)}
                          className="text-xs"
                          aria-label="カテゴリ"
                        >
                          {categories.map((category) => (
                            <option key={category.id} value={category.id}>
                              {category.label}
                            </option>
                          ))}
                        </Select>
                      </div>
                    )}
                  </div>

                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    <span className="tnum text-sm font-semibold text-ink">{formatYen(txn.amount)}</span>
                    <div className="flex gap-1">
                      <button
                        type="button"
                        onClick={() => setEditing(txn)}
                        className="rounded-md p-1.5 text-ink-2 hover:bg-plane"
                        aria-label="内訳を分ける"
                        title="内訳を分ける"
                      >
                        <Scissors size={15} />
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (window.confirm('この明細を消しますか')) void removeTransaction(txn.id);
                        }}
                        className="rounded-md p-1.5 text-ink-2 hover:bg-plane"
                        aria-label="消す"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {editing && (
        <SplitDialog
          transaction={editing}
          categories={snapshot.categories}
          onClose={() => setEditing(undefined)}
          onSave={saveTransaction}
        />
      )}
    </div>
  );
}
