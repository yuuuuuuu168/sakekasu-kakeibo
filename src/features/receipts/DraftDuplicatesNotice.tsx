import { Copy } from 'lucide-react';
import { duplicateKey, formatMoney, receiptCurrency, type DuplicateReceiptPair, type Receipt } from '@kakeibo/core';
import { Button } from '../../components/ui/primitives';
import { ReceiptStatusBadge } from './ReceiptParts';

/**
 * 読み取ったばかりの下書きが、保存済みのレシートと同じかもしれないという警告。
 * 登録してから下の「同じレシートかもしれない組」で気づくと、片方を消す手間が増えるので、保存する前に出す。
 * 組の a は下書き、b は保存済み（core の findDuplicatesOfDraft）。
 */
export function DraftDuplicatesNotice({
  pairs,
  onOpen,
  onDismiss,
}: {
  pairs: DuplicateReceiptPair[];
  /** 同じものだった。この読み取りはやめて、保存済みのほうを開く */
  onOpen: (saved: Receipt) => void;
  /** 別の買い物だった。保存するとき、下書きの側に印を付ける */
  onDismiss: (saved: Receipt) => void;
}) {
  return (
    <div role="alert" className="mb-3 rounded-lg bg-warning/12 px-3 py-2 text-ink">
      <p className="text-sm font-semibold">保存済みのレシートと同じかもしれません</p>
      <p className="mt-0.5 text-xs text-ink-2">登録済みなら、ここでやめて保存済みのほうを開いてください。</p>
      <ul className="mt-2 space-y-2">
        {pairs.map((pair) => (
          <li key={duplicateKey(pair)} className="rounded-lg bg-surface px-2 py-1.5">
            <div className="flex items-center gap-2">
              <span className="tnum text-xs text-muted">{pair.b.date.slice(5)}</span>
              <span className="min-w-0 flex-1 truncate text-sm text-ink">{pair.b.storeName || '（店名なし）'}</span>
              <ReceiptStatusBadge receipt={pair.b} />
              <span className="tnum text-sm text-ink">{formatMoney(pair.b.total, receiptCurrency(pair.b))}</span>
            </div>
            <div className="mt-1 flex items-center gap-1.5">
              <Copy size={12} className="text-muted" aria-hidden />
              <span className="text-xs text-muted">{pair.reasons.join('・')}</span>
            </div>
            <div className="mt-1.5 flex flex-wrap justify-end gap-2">
              <Button size="sm" onClick={() => onDismiss(pair.b)}>
                別の買い物
              </Button>
              <Button size="sm" variant="primary" onClick={() => onOpen(pair.b)}>
                やめて保存済みを開く
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
