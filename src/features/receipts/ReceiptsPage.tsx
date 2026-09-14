import { useMemo, useRef, useState } from 'react';
import { Camera, Copy, Plus, Trash2 } from 'lucide-react';
import {
  UNCATEGORIZED_ID,
  activeCategories,
  applyReceipt,
  autoMatch,
  categoryLabel,
  classifyItem,
  duplicateKey,
  findCandidates,
  findDuplicateReceipts,
  formatYen,
  splitsFromReceipt,
  transactionId,
  type MatchCandidate,
  type Receipt,
  type ReceiptItem,
  type Transaction,
} from '@kakeibo/core';
import { api } from '../../api/index';
import { uploadToS3 } from '../../api/remote';
import { useStore } from '../../api/store';
import { Badge, Button, Card, EmptyState, Field, Input, Select } from '../../components/ui/primitives';
import { config } from '../../config';
import { todayIso } from '../../lib/month';

type Draft = {
  id: string;
  storeName: string;
  date: string;
  total: number;
  items: ReceiptItem[];
  imageKey?: string;
  warnings?: string[];
};

function emptyDraft(): Draft {
  return { id: `r-${Date.now().toString(36)}`, storeName: '', date: todayIso(), total: 0, items: [] };
}

/**
 * レシートを読み込んで明細に当てる画面。この家計簿の主役。
 * 写真 → OCR → 品目ごとのカテゴリ → 金額と日付で明細に自動マッチ、までを 1 画面で済ませる。
 */
export function ReceiptsPage() {
  const { snapshot, saveReceipt, removeReceipt, saveTransaction, saveTransactions } = useStore();
  const fileRef = useRef<HTMLInputElement>(null);

  const [draft, setDraft] = useState<Draft | undefined>();
  const [selectedTxnId, setSelectedTxnId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>();

  const categories = activeCategories(snapshot.categories);

  /**
   * 同じレシートを 2 回撮ったもの。ID は撮った時刻から作るので中身が同じでも別 ID になり、
   * 保存済み一覧では未紐付けが 2 枚並ぶだけで気づけない。ここで名指しする。
   */
  const duplicates = useMemo(() => findDuplicateReceipts(snapshot.receipts), [snapshot.receipts]);

  const candidates = useMemo<MatchCandidate[]>(() => {
    if (!draft || draft.total <= 0) return [];
    const receipt: Receipt = { ...draft, items: draft.items, status: 'pending' };
    return findCandidates(receipt, snapshot.transactions);
  }, [draft, snapshot.transactions]);

  async function onImage(file: File) {
    setBusy(true);
    setMessage(undefined);
    try {
      const target = await api.requestUpload(file.type || 'image/jpeg');
      await uploadToS3(target, file);
      const result = await api.analyzeReceipt({ key: target.key });
      const next: Draft = {
        id: `r-${Date.now().toString(36)}`,
        storeName: result.storeName,
        date: result.date || todayIso(),
        total: result.total,
        items: result.items.map((item) => ({ ...item, categoryId: classifyItem(item.name, item.categoryId) })),
        imageKey: target.key,
        ...(result.warnings ? { warnings: result.warnings } : {}),
      };
      setDraft(next);
      const auto = autoMatch(findCandidates({ ...next, status: 'pending' }, snapshot.transactions));
      setSelectedTxnId(auto?.id);
      if (auto) setMessage(`${auto.rawMerchant} の明細に自動で当てました。違っていれば下で選び直してください。`);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
      setDraft(emptyDraft());
    } finally {
      setBusy(false);
    }
  }

  async function save(asCash: boolean) {
    if (!draft) return;
    setBusy(true);
    try {
      const receipt: Receipt = {
        ...draft,
        items: draft.items,
        status: asCash ? 'cash' : selectedTxnId ? 'matched' : 'pending',
        ...(selectedTxnId && !asCash ? { txnId: selectedTxnId } : {}),
        createdAt: new Date().toISOString(),
      };
      await saveReceipt(receipt);

      if (asCash) {
        const id = transactionId('cash', receipt.date, receipt.total, receipt.storeName);
        const cash: Transaction = {
          id,
          date: receipt.date,
          amount: receipt.total,
          rawMerchant: receipt.storeName,
          merchant: receipt.storeName,
          source: 'cash',
          sourceLabel: '現金',
          splits: splitsFromReceipt(receipt, receipt.total),
          needsDetail: false,
          receiptId: receipt.id,
        };
        await saveTransactions([cash]);
        setMessage('現金払いとして明細に足しました。');
      } else if (selectedTxnId) {
        const txn = snapshot.transactions.find((item) => item.id === selectedTxnId);
        if (txn) {
          await saveTransaction(applyReceipt(txn, receipt));
          setMessage('明細に当てました。内訳が品目ごとに分かれています。');
        }
      } else {
        setMessage('レシートだけ保存しました。対応する明細を取り込んだら、もう一度開いて当ててください。');
      }

      setDraft(undefined);
      setSelectedTxnId(undefined);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const itemsTotal = draft?.items.reduce((sum, item) => sum + item.amount, 0) ?? 0;

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-ink">レシート</h1>

      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" onClick={() => fileRef.current?.click()} disabled={busy || config.mode === 'local'}>
            <Camera size={15} />
            写真を読む
          </Button>
          <Button onClick={() => setDraft(emptyDraft())} disabled={busy}>
            手で入れる
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void onImage(file);
              event.target.value = '';
            }}
          />
        </div>
        <p className="mt-2 text-xs text-muted">
          {config.mode === 'local'
            ? 'ローカルモードでは OCR が使えません。品目を手で入れるか、AWS 側をデプロイしてください。'
            : '写真を撮ると Bedrock が品目と金額を読み、金額と日付の近い明細に自動で当てます。'}
        </p>
        {message && <p className="mt-3 rounded-lg bg-plane px-3 py-2 text-sm text-ink">{message}</p>}
      </Card>

      {draft && (
        <Card title="読み取り結果" action={<Button size="sm" onClick={() => setDraft(undefined)}>やめる</Button>}>
          {draft.warnings && draft.warnings.length > 0 && (
            <ul className="mb-3 space-y-1 rounded-lg bg-warning/12 px-3 py-2 text-xs text-ink">
              {draft.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}

          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="店名">
              <Input value={draft.storeName} onChange={(event) => setDraft({ ...draft, storeName: event.target.value })} />
            </Field>
            <Field label="日付">
              <Input type="date" value={draft.date} onChange={(event) => setDraft({ ...draft, date: event.target.value })} />
            </Field>
            <Field label="合計" hint={itemsTotal !== draft.total ? `品目の合計は ${formatYen(itemsTotal)}` : undefined}>
              <Input
                type="number"
                inputMode="numeric"
                value={draft.total}
                onChange={(event) => setDraft({ ...draft, total: Math.round(Number(event.target.value) || 0) })}
                className="tnum text-right"
              />
            </Field>
          </div>

          <h3 className="mt-4 text-xs font-semibold text-ink-2">品目</h3>
          <ul className="mt-1 space-y-2">
            {draft.items.map((item, index) => (
              <li key={`${item.name}-${index}`} className="flex items-center gap-2">
                <Input
                  value={item.name}
                  onChange={(event) =>
                    setDraft({ ...draft, items: draft.items.map((row, position) => (position === index ? { ...row, name: event.target.value } : row)) })
                  }
                  className="flex-1"
                  aria-label="品目名"
                />
                <Select
                  value={item.categoryId ?? UNCATEGORIZED_ID}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      items: draft.items.map((row, position) => (position === index ? { ...row, categoryId: event.target.value } : row)),
                    })
                  }
                  className="w-32"
                  aria-label="カテゴリ"
                >
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.label}
                    </option>
                  ))}
                </Select>
                <Input
                  type="number"
                  inputMode="numeric"
                  value={item.amount}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      items: draft.items.map((row, position) =>
                        position === index ? { ...row, amount: Math.round(Number(event.target.value) || 0) } : row,
                      ),
                    })
                  }
                  className="tnum w-24 text-right"
                  aria-label="金額"
                />
                <button
                  type="button"
                  onClick={() => setDraft({ ...draft, items: draft.items.filter((_, position) => position !== index) })}
                  className="rounded-md p-1.5 text-ink-2 hover:bg-plane"
                  aria-label="この品目を消す"
                >
                  <Trash2 size={15} />
                </button>
              </li>
            ))}
          </ul>
          <Button
            size="sm"
            className="mt-2"
            onClick={() => setDraft({ ...draft, items: [...draft.items, { name: '', amount: 0, categoryId: UNCATEGORIZED_ID }] })}
          >
            <Plus size={14} />
            品目を足す
          </Button>

          <h3 className="mt-4 text-xs font-semibold text-ink-2">当てる明細</h3>
          {candidates.length === 0 ? (
            <p className="mt-1 text-sm text-ink-2">
              金額 {formatYen(draft.total)} に一致する明細がありません。現金払いならそのまま登録できます。
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
                      onChange={() => setSelectedTxnId(candidate.txn.id)}
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

          <div className="mt-4 flex flex-wrap justify-end gap-2 border-t border-grid pt-3">
            <Button onClick={() => void save(true)} disabled={busy || draft.total <= 0}>
              現金払いとして登録
            </Button>
            <Button variant="primary" onClick={() => void save(false)} disabled={busy || draft.total <= 0}>
              {selectedTxnId ? '明細に当てる' : 'レシートだけ保存'}
            </Button>
          </div>
        </Card>
      )}

      {duplicates.length > 0 && (
        <Card title={`同じレシートかもしれない組 ${duplicates.length} 件`}>
          <p className="text-xs text-muted">
            合計が一致して日付が近いレシートです。2 回撮ったものなら片方を消してください。別々の買い物ならそのままで構いません
          </p>
          <ul className="mt-2 divide-y divide-grid">
            {duplicates.map((pair) => (
              <li key={duplicateKey(pair)} className="py-2">
                <div className="flex items-center gap-1.5">
                  <Copy size={14} className="text-muted" aria-hidden />
                  <span className="text-xs text-muted">{pair.reasons.join('・')}</span>
                </div>
                <ul className="mt-1.5 space-y-1">
                  {[pair.a, pair.b].map((item) => (
                    <li key={item.id} className="flex items-center gap-2 rounded-lg bg-plane px-2 py-1.5">
                      <span className="tnum text-xs text-muted">{item.date.slice(5)}</span>
                      <span className="min-w-0 flex-1 truncate text-sm text-ink">{item.storeName || '（店名なし）'}</span>
                      {item.status === 'matched' && <Badge tone="good">明細に紐付き</Badge>}
                      {item.status === 'cash' && <Badge tone="neutral">現金</Badge>}
                      {item.status === 'pending' && <Badge tone="warning">未紐付け</Badge>}
                      <span className="tnum text-sm font-semibold text-ink">{formatYen(item.total)}</span>
                      <button
                        type="button"
                        onClick={() => {
                          if (window.confirm('このレシートを消しますか')) void removeReceipt(item.id);
                        }}
                        className="rounded-md p-1.5 text-ink-2 hover:bg-surface"
                        aria-label={`${item.date} の ${item.storeName || '店名なし'} のレシートを消す`}
                      >
                        <Trash2 size={15} />
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title={`保存済み ${snapshot.receipts.length} 枚`}>
        {snapshot.receipts.length === 0 ? (
          <EmptyState title="まだレシートがありません">
            内訳待ちの明細は、レシートを読ませると品目ごとに分かれます
          </EmptyState>
        ) : (
          <ul className="divide-y divide-grid">
            {[...snapshot.receipts]
              .sort((a, b) => b.date.localeCompare(a.date))
              .map((receipt) => (
                <li key={receipt.id} className="flex items-center gap-2 py-2">
                  <span className="tnum text-xs text-muted">{receipt.date.slice(5)}</span>
                  <span className="min-w-0 flex-1 truncate text-sm text-ink">{receipt.storeName || '（店名なし）'}</span>
                  <span className="text-xs text-muted">
                    {receipt.items.length > 0
                      ? receipt.items
                          .slice(0, 2)
                          .map((item) => categoryLabel(snapshot.categories, item.categoryId ?? UNCATEGORIZED_ID))
                          .join('・')
                      : '品目なし'}
                  </span>
                  {receipt.status === 'matched' && <Badge tone="good">明細に紐付き</Badge>}
                  {receipt.status === 'cash' && <Badge tone="neutral">現金</Badge>}
                  {receipt.status === 'pending' && <Badge tone="warning">未紐付け</Badge>}
                  <span className="tnum text-sm font-medium text-ink">{formatYen(receipt.total)}</span>
                  <button
                    type="button"
                    onClick={() => {
                      if (window.confirm('このレシートを消しますか')) void removeReceipt(receipt.id);
                    }}
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
    </div>
  );
}
