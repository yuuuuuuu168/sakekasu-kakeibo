import { formatMoney, formatYen, type MatchCandidate } from '@kakeibo/core';
import { yenHint, type Draft } from './draft';

/**
 * 読み取ったレシートを当てる明細の候補。金額と日付の近いもの（core の findCandidates）を並べて 1 つ選ばせる。
 * 候補が無ければ、支払い方法を選んでそのまま明細として登録できることを伝える
 */
export function MatchCandidates({
  draft,
  candidates,
  selectedTxnId,
  onSelect,
}: {
  draft: Draft;
  candidates: MatchCandidate[];
  selectedTxnId: string | undefined;
  onSelect: (txnId: string) => void;
}) {
  const hint = yenHint(draft);
  return (
    <>
      <h3 className="mt-4 text-xs font-semibold text-ink-2">当てる明細</h3>
      {candidates.length === 0 ? (
        <p className="mt-1 text-sm text-ink-2">
          {draft.currency === 'JPY'
            ? `金額 ${formatYen(draft.total)} に一致する明細がありません。`
            : `${formatMoney(draft.total, draft.currency)}${hint ? `（${hint}）` : ''} に近い明細がありません。`}
          支払い方法を選べば、そのまま明細として登録できます。
        </p>
      ) : (
        <ul className="mt-1 space-y-1">
          {candidates.map((candidate) => (
            <li key={candidate.txn.id}>
              <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-plane">
                <input
                  type="radio"
                  name="candidate"
                  checked={selectedTxnId === candidate.txn.id}
                  onChange={() => onSelect(candidate.txn.id)}
                />
                <span className="tnum text-xs text-muted">{candidate.txn.date.slice(5)}</span>
                <span className="min-w-0 flex-1 truncate text-sm text-ink">{candidate.txn.rawMerchant}</span>
                <span className="text-xs text-muted">{candidate.reasons.join('・')}</span>
                <span className="tnum text-sm text-ink">{formatYen(candidate.txn.amount)}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
