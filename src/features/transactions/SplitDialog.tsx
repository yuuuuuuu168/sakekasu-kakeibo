import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import {
  UNCATEGORIZED_ID,
  activeCategories,
  applySplits,
  formatYen,
  splitEvenly,
  sumSplits,
  type Category,
  type Split,
  type Transaction,
} from '@kakeibo/core';
import { Dialog } from '../../components/ui/Dialog';
import { Button, Input, Select } from '../../components/ui/primitives';

/**
 * 1 回の支払いを複数のカテゴリに割る画面。
 * レシートが無いとき用の逃げ道で、コンビニの 1,200 円を 食費 800 / 日用品 400 にする。
 */
export function SplitDialog({
  transaction,
  categories,
  onClose,
  onSave,
}: {
  transaction: Transaction;
  categories: Category[];
  onClose: () => void;
  onSave: (transaction: Transaction) => Promise<void>;
}) {
  const options = activeCategories(categories);
  const [rows, setRows] = useState<Split[]>(
    transaction.splits.length > 0
      ? transaction.splits
      : [{ id: 'split-1', amount: transaction.amount, categoryId: UNCATEGORIZED_ID, origin: 'manual' }],
  );
  const [busy, setBusy] = useState(false);

  const total = sumSplits(rows);
  const gap = transaction.amount - total;

  function change(index: number, patch: Partial<Split>) {
    setRows(rows.map((row, position) => (position === index ? { ...row, ...patch } : row)));
  }

  return (
    <Dialog title="内訳を分ける" onClose={onClose}>
      <div className="space-y-3">
        <div className="flex items-baseline justify-between">
          <span className="text-sm text-ink-2">{transaction.rawMerchant}</span>
          <span className="tnum text-base font-semibold text-ink">{formatYen(transaction.amount)}</span>
        </div>

        <ul className="space-y-2">
          {rows.map((row, index) => (
            <li key={row.id} className="flex items-center gap-2">
              <Select value={row.categoryId} onChange={(event) => change(index, { categoryId: event.target.value })} className="flex-1">
                {options.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.label}
                  </option>
                ))}
              </Select>
              <Input
                type="number"
                inputMode="numeric"
                value={row.amount}
                onChange={(event) => change(index, { amount: Math.round(Number(event.target.value) || 0) })}
                className="tnum w-28 text-right"
                aria-label="金額"
              />
              <button
                type="button"
                onClick={() => setRows(rows.filter((_, position) => position !== index))}
                disabled={rows.length <= 1}
                className="rounded-md p-1.5 text-ink-2 hover:bg-plane disabled:opacity-30"
                aria-label="この行を消す"
              >
                <Trash2 size={15} />
              </button>
            </li>
          ))}
        </ul>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={() =>
              setRows([
                ...rows,
                { id: `split-${rows.length + 1}-${Date.now()}`, amount: Math.max(gap, 0), categoryId: UNCATEGORIZED_ID, origin: 'manual' },
              ])
            }
          >
            <Plus size={14} />
            行を足す
          </Button>
          <Button size="sm" onClick={() => setRows(splitEvenly(transaction.amount, rows.map((row) => row.categoryId)))}>
            均等に割る
          </Button>
          <div className="flex-1" />
          <span className={gap === 0 ? 'tnum text-xs text-success-text' : 'tnum text-xs text-critical'}>
            {gap === 0 ? '差額なし' : `差額 ${formatYen(gap)}`}
          </span>
        </div>

        <p className="text-xs text-muted">
          差額があるまま保存すると、金額の大きい行に寄せて辻褄を合わせます。内訳の合計はいつも明細の金額に一致します。
        </p>

        <div className="flex justify-end gap-2 border-t border-grid pt-3">
          <Button onClick={onClose}>やめる</Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onSave(applySplits(transaction, rows));
                onClose();
              } finally {
                setBusy(false);
              }
            }}
          >
            保存する
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
