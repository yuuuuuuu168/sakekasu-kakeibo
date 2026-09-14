import { useMemo, useState } from 'react';
import { Copy, Scissors, Trash2 } from 'lucide-react';
import {
  UNCATEGORIZED_ID,
  activeCategories,
  categoryLabel,
  duplicateKey,
  findDuplicates,
  formatYen,
  learnRule,
  markNotDuplicate,
  monthOf,
  transactionsOfMonth,
  type DuplicatePair,
  type Transaction,
} from '@kakeibo/core';
import { useStore } from '../../api/store';
import { Badge, Button, Card, EmptyState, Select } from '../../components/ui/primitives';
import { MonthPicker } from '../../components/ui/MonthPicker';
import { SplitDialog } from './SplitDialog';
import { currentMonth } from '../../lib/month';
import { DUPLICATES_FILTER, NEEDS_DETAIL_FILTER } from '../../lib/router';

export function TransactionsPage({ month: initialMonth, filter: initialFilter }: { month?: string; filter?: string }) {
  const { snapshot, saveTransaction, removeTransaction, saveRules } = useStore();
  const [month, setMonth] = useState(initialMonth ?? currentMonth());
  const [filter, setFilter] = useState(initialFilter ?? 'all');
  const [editing, setEditing] = useState<Transaction | undefined>();

  const categories = activeCategories(snapshot.categories);

  const rows = useMemo(() => {
    const monthly = transactionsOfMonth(snapshot.transactions, month).sort((a, b) => b.date.localeCompare(a.date));
    if (filter === 'all') return monthly;
    if (filter === NEEDS_DETAIL_FILTER) return monthly.filter((txn) => txn.needsDetail);
    return monthly.filter((txn) => txn.splits.some((split) => split.categoryId === filter));
  }, [snapshot.transactions, month, filter]);

  /**
   * 重複は月をまたぐ。月末に現金で保存したレシートと、翌月頭に計上されたカード明細が典型。
   * そこで探すのは全件からにして、どちらかがこの月に入る組だけを出す。
   */
  const duplicates = useMemo(() => {
    if (filter !== DUPLICATES_FILTER) return [];
    return findDuplicates(snapshot.transactions).filter(
      (pair) => monthOf(pair.a.date) === month || monthOf(pair.b.date) === month,
    );
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

  /** 重複ではないと言われた組。両側に印を付けて、次からは候補に出さない */
  async function dismissDuplicate(pair: DuplicatePair) {
    const [a, b] = markNotDuplicate(pair.a, pair.b);
    await saveTransaction(a);
    await saveTransaction(b);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-ink">明細</h1>
        <div className="flex items-center gap-2">
          <Select value={filter} onChange={(event) => setFilter(event.target.value)}>
            <option value="all">すべて</option>
            <option value={NEEDS_DETAIL_FILTER}>内訳待ちだけ</option>
            <option value={DUPLICATES_FILTER}>重複の可能性だけ</option>
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

      {filter === DUPLICATES_FILTER ? (
        <DuplicatesCard pairs={duplicates} onRemove={removeTransaction} onDismiss={dismissDuplicate} />
      ) : (
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
      )}

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

/**
 * 重複候補は 1 件ずつではなく組で見せる。どちらを消すかを決めるには両方の日付と
 * 取り込み元が要るので、明細一覧の行の形では足りない。
 */
function DuplicatesCard({
  pairs,
  onRemove,
  onDismiss,
}: {
  pairs: DuplicatePair[];
  onRemove: (id: string) => Promise<void>;
  onDismiss: (pair: DuplicatePair) => Promise<void>;
}) {
  return (
    <Card title={`重複の可能性 ${pairs.length} 組`}>
      {pairs.length === 0 ? (
        <EmptyState title="重複の可能性はありません">
          金額が一致して日付が 4 日以内の明細どうしを見ています。「重複ではない」と印を付けた組は出ません
        </EmptyState>
      ) : (
        <ul className="divide-y divide-grid">
          {pairs.map((pair) => (
            <li key={duplicateKey(pair)} className="py-3">
              <div className="flex items-center gap-1.5">
                <Copy size={14} className="text-muted" aria-hidden />
                <span className="text-xs text-muted">{pair.reasons.join('・')}</span>
              </div>

              <ul className="mt-2 space-y-1">
                {[pair.a, pair.b].map((txn) => (
                  <li key={txn.id} className="flex items-center gap-2 rounded-lg bg-plane px-2 py-1.5">
                    <span className="tnum text-xs text-muted">{txn.date.slice(5)}</span>
                    <span className="min-w-0 flex-1 truncate text-sm text-ink">{txn.rawMerchant || '（店名なし）'}</span>
                    <span className="text-xs text-muted">{txn.sourceLabel}</span>
                    {txn.receiptId && <Badge tone="good">レシートあり</Badge>}
                    <span className="tnum text-sm font-semibold text-ink">{formatYen(txn.amount)}</span>
                    <button
                      type="button"
                      onClick={() => {
                        if (window.confirm('この明細を消しますか。内訳も一緒に消えます')) void onRemove(txn.id);
                      }}
                      className="rounded-md p-1.5 text-ink-2 hover:bg-surface"
                      aria-label={`${txn.date} の ${txn.rawMerchant || '店名なし'}（${txn.sourceLabel}）を消す`}
                    >
                      <Trash2 size={15} />
                    </button>
                  </li>
                ))}
              </ul>

              <div className="mt-2 flex justify-end">
                <Button size="sm" onClick={() => void onDismiss(pair)}>
                  重複ではない
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
