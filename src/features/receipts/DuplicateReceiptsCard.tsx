import { useState } from 'react';
import { Copy } from 'lucide-react';
import { duplicateKey, formatMoney, receiptCurrency, type DuplicateReceiptPair, type Receipt } from '@kakeibo/core';
import { Button, Card } from '../../components/ui/primitives';
import { ReceiptStatusBadge } from './ReceiptParts';

/** 見比べるのに出す品目の行数。長いレシートで組が縦に伸びすぎないよう、残りは開いたときだけ */
const DUPLICATE_ITEM_LINES = 5;

/**
 * 同じレシートかもしれない組。合計は一致しているので、見比べる材料は品目のほうにある。
 * 人に答えてもらう形にして、同じなら残す方を選んで片方を消し、別の買い物なら両方残して二度と聞かない。
 */
export function DuplicateReceiptsCard({
  pairs,
  onKeep,
  onDismiss,
}: {
  pairs: DuplicateReceiptPair[];
  onKeep: (keep: Receipt, drop: Receipt) => Promise<void>;
  onDismiss: (pair: DuplicateReceiptPair) => Promise<void>;
}) {
  return (
    <Card title={`同じレシートかもしれない組 ${pairs.length} 件`}>
      <p className="text-xs text-muted">
        合計が一致して日付が近いレシートです。品目を見比べて、2 回撮ったものなら残す方を選んでください。別々の買い物なら「別の買い物」を押すと、この組は二度と出ません
      </p>
      <ul className="mt-2 divide-y divide-grid">
        {pairs.map((pair) => (
          <li key={duplicateKey(pair)} className="py-3">
            <div className="flex items-center gap-1.5">
              <Copy size={14} className="text-muted" aria-hidden />
              <span className="text-xs text-muted">{pair.reasons.join('・')}</span>
            </div>
            <ul className="mt-2 grid gap-2 md:grid-cols-2">
              {[
                [pair.a, pair.b],
                [pair.b, pair.a],
              ].map(([item, other]) => (
                <li key={item.id} className="rounded-lg bg-plane px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="tnum text-xs text-muted">{item.date.slice(5)}</span>
                    <span className="min-w-0 flex-1 truncate text-sm text-ink">{item.storeName || '（店名なし）'}</span>
                    <ReceiptStatusBadge receipt={item} />
                    <span className="tnum text-sm font-semibold text-ink">{formatMoney(item.total, receiptCurrency(item))}</span>
                  </div>
                  <DuplicateReceiptItems receipt={item} />
                  <div className="mt-2 flex justify-end">
                    <Button size="sm" onClick={() => void onKeep(item, other)}>
                      同じレシート：こちらを残す
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
            <div className="mt-2 flex justify-end">
              <Button size="sm" variant="primary" onClick={() => void onDismiss(pair)}>
                別の買い物（両方残す）
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** 組の片側の品目。同じ会計かどうかはここを見比べて決めてもらう */
function DuplicateReceiptItems({ receipt }: { receipt: Receipt }) {
  const [expanded, setExpanded] = useState(false);
  if (receipt.items.length === 0) return <p className="mt-1.5 border-t border-grid pt-1.5 text-xs text-muted">品目なし</p>;
  const items = expanded ? receipt.items : receipt.items.slice(0, DUPLICATE_ITEM_LINES);
  const hidden = receipt.items.length - items.length;
  return (
    <div className="mt-1.5 border-t border-grid pt-1.5 text-xs">
      <ul className="space-y-0.5" aria-label={`${receipt.date} の ${receipt.storeName || '店名なし'} の品目`}>
        {items.map((item, index) => (
          <li key={index} className="flex items-baseline gap-2">
            <span className="truncate text-ink-2">{item.name || '（品名なし）'}</span>
            <span className="flex-1 border-b border-dotted border-grid" />
            <span className="tnum text-ink-2">{formatMoney(item.amount, receiptCurrency(receipt))}</span>
          </li>
        ))}
      </ul>
      {receipt.items.length > DUPLICATE_ITEM_LINES && (
        <button type="button" onClick={() => setExpanded(!expanded)} className="text-accent">
          {expanded ? '閉じる' : `ほか ${hidden} 品を見る`}
        </button>
      )}
    </div>
  );
}
