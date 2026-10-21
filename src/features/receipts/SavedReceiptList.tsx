import { Trash2 } from 'lucide-react';
import { formatMoney, receiptCategorySummary, receiptCurrency, type Category, type Receipt } from '@kakeibo/core';
import { Card, EmptyState } from '../../components/ui/primitives';
import { ReceiptStatusBadge } from './ReceiptParts';

/** 保存済みのレシートの一覧。新しい日付から並べ、行を押すと上の欄に開く */
export function SavedReceiptList({
  receipts,
  categories,
  onOpen,
  onDelete,
}: {
  receipts: Receipt[];
  categories: Category[];
  onOpen: (receipt: Receipt) => void;
  onDelete: (receipt: Receipt) => void;
}) {
  return (
    <Card title={`保存済み ${receipts.length} 枚`}>
      {receipts.length === 0 ? (
        <EmptyState title="まだレシートがありません">
          内訳待ちの明細は、レシートを読ませると品目ごとに分かれます
        </EmptyState>
      ) : (
        <ul className="divide-y divide-grid">
          {[...receipts]
            .sort((a, b) => b.date.localeCompare(a.date))
            .map((receipt) => (
              <li key={receipt.id} className="flex items-center gap-2 py-2">
                {/* 行を押すと上の欄に開いて、中身を見たり直したりできる */}
                <button
                  type="button"
                  onClick={() => onOpen(receipt)}
                  className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left hover:bg-plane"
                  aria-label={`${receipt.date} の ${receipt.storeName || '店名なし'} のレシートを開く`}
                >
                  <span className="tnum text-xs text-muted">{receipt.date.slice(5)}</span>
                  <span className="min-w-0 flex-1 truncate text-sm text-ink">{receipt.storeName || '（店名なし）'}</span>
                  <span className="shrink-0 text-xs text-muted">{receiptCategorySummary(receipt, categories)}</span>
                </button>
                <ReceiptStatusBadge receipt={receipt} />
                <span className="tnum text-sm font-medium text-ink">{formatMoney(receipt.total, receiptCurrency(receipt))}</span>
                <button
                  type="button"
                  onClick={() => onDelete(receipt)}
                  className="rounded-md p-1.5 text-ink-2 hover:bg-plane"
                  aria-label="消す"
                >
                  <Trash2 size={15} />
                </button>
              </li>
            ))}
        </ul>
      )}
    </Card>
  );
}
