import { useMemo, useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import {
  buildTransactions,
  categoryLabel,
  decodeStatementBytes,
  detectColumns,
  detectDelimiter,
  formatYen,
  isMappingComplete,
  mergeImported,
  parseCsv,
  type ColumnMapping,
  type SourceKind,
  type Transaction,
} from '@kakeibo/core';
import { useStore } from '../../api/store';
import { Button, Card, EmptyState, Field, Input, Select } from '../../components/ui/primitives';
import { navigate } from '../../lib/router';
import { parsePdfStatement } from './parsePdf';
import type { SkippedRow } from '@kakeibo/core';

type Loaded = {
  fileName: string;
  rows: string[][];
  encoding: string;
  kind: 'csv' | 'pdf';
};

const SOURCE_OPTIONS: { value: SourceKind; label: string }[] = [
  { value: 'credit', label: 'クレジットカード' },
  { value: 'paypay', label: 'PayPay' },
  { value: 'cash', label: '現金' },
  { value: 'manual', label: 'その他' },
];

export function ImportPage() {
  const { snapshot, rules, saveTransactions, saveMapping } = useStore();
  const inputRef = useRef<HTMLInputElement>(null);

  const [loaded, setLoaded] = useState<Loaded | undefined>();
  const [mapping, setMapping] = useState<ColumnMapping | undefined>();
  const [source, setSource] = useState<SourceKind>('credit');
  const [sourceLabel, setSourceLabel] = useState('');
  const [message, setMessage] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const width = useMemo(() => Math.max(0, ...(loaded?.rows ?? []).map((row) => row.length)), [loaded]);

  const result = useMemo(() => {
    if (!loaded || !mapping) return undefined;
    return buildTransactions({
      rows: loaded.rows,
      mapping,
      source,
      sourceLabel: sourceLabel || SOURCE_OPTIONS.find((option) => option.value === source)!.label,
      rules,
      importId: `${Date.now()}`,
      referenceYear: new Date().getFullYear(),
    });
  }, [loaded, mapping, source, sourceLabel, rules]);

  const duplicates = useMemo(() => {
    if (!result) return 0;
    const known = new Set(snapshot.transactions.map((txn) => txn.id));
    return result.transactions.filter((txn) => known.has(txn.id)).length;
  }, [result, snapshot.transactions]);

  async function onFile(file: File) {
    setMessage(undefined);
    setBusy(true);
    try {
      if (file.name.toLowerCase().endsWith('.pdf')) {
        const parsed = await parsePdfStatement(file);
        if (parsed.imageOnly) {
          setMessage('この PDF は文字を持っていません（画像として出力されています）。CSV でダウンロードし直してください。');
          return;
        }
        if (parsed.rows.length === 0) {
          setMessage(`${parsed.pageCount} ページを読みましたが、明細の行が見つかりませんでした。CSV があればそちらを使ってください。`);
          return;
        }
        setLoaded({ fileName: file.name, rows: parsed.rows, encoding: 'pdf', kind: 'pdf' });
        setMapping({ headerRowIndex: -1, date: 0, merchant: 1, amount: 2, sign: 'positive-expense' });
        return;
      }

      const bytes = new Uint8Array(await file.arrayBuffer());
      const decoded = decodeStatementBytes(bytes);
      const rows = parseCsv(decoded.text, detectDelimiter(decoded.text));
      if (rows.length === 0) {
        setMessage('中身が空でした。');
        return;
      }

      const saved = snapshot.mappings.find((item) => item.source === source);
      setLoaded({ fileName: file.name, rows, encoding: decoded.encoding, kind: 'csv' });
      setMapping(saved?.mapping ?? detectColumns(rows));
      if (saved) setSourceLabel(saved.label);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!result || !mapping) return;
    setBusy(true);
    try {
      const merge = mergeImported(snapshot.transactions, result.transactions);
      const fresh = result.transactions.filter((txn) => !snapshot.transactions.some((known) => known.id === txn.id));
      await saveTransactions(fresh);
      await saveMapping({
        sourceId: source,
        label: sourceLabel || SOURCE_OPTIONS.find((option) => option.value === source)!.label,
        source,
        mapping,
      });
      setMessage(`${merge.added} 件を取り込みました。${merge.kept > 0 ? `${merge.kept} 件は既にあったので飛ばしました。` : ''}`);
      setLoaded(undefined);
      setMapping(undefined);
      if (merge.added > 0) navigate('#/transactions');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-ink">明細の取り込み</h1>

      <Card>
        <div
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            const file = event.dataTransfer.files[0];
            if (file) void onFile(file);
          }}
          className="rounded-lg border border-dashed border-axis px-4 py-8 text-center"
        >
          <Upload size={20} className="mx-auto text-muted" aria-hidden />
          <p className="mt-2 text-sm text-ink">CSV か PDF をここに落とす</p>
          <p className="mt-1 text-xs text-muted">Shift_JIS の CSV もそのまま読めます。解析はブラウザの中だけで行います</p>
          <Button className="mt-3" onClick={() => inputRef.current?.click()} disabled={busy}>
            ファイルを選ぶ
          </Button>
          <input
            ref={inputRef}
            type="file"
            accept=".csv,.tsv,.txt,.pdf"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void onFile(file);
              event.target.value = '';
            }}
          />
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Field label="取り込み元">
            <Select value={source} onChange={(event) => setSource(event.target.value as SourceKind)} className="w-full">
              {SOURCE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="表示名" hint="「楽天カード」など。明細一覧に出ます">
            <Input value={sourceLabel} onChange={(event) => setSourceLabel(event.target.value)} placeholder="楽天カード" />
          </Field>
        </div>

        {message && <p className="mt-3 rounded-lg bg-plane px-3 py-2 text-sm text-ink">{message}</p>}
      </Card>

      {loaded && mapping && (
        <Card
          title={`${loaded.fileName}（${loaded.kind === 'pdf' ? 'PDF' : loaded.encoding}）`}
          action={
            <Button
              variant="primary"
              size="sm"
              onClick={() => void confirm()}
              disabled={busy || !result || result.transactions.length === 0}
            >
              {result ? `${result.transactions.length - duplicates} 件を取り込む` : '取り込む'}
            </Button>
          }
        >
          <div className="grid gap-3 sm:grid-cols-4">
            <ColumnSelect label="日付の列" value={mapping.date} width={width} loaded={loaded} onChange={(date) => setMapping({ ...mapping, date })} />
            <ColumnSelect label="店名の列" value={mapping.merchant} width={width} loaded={loaded} onChange={(merchant) => setMapping({ ...mapping, merchant })} />
            <ColumnSelect label="金額の列" value={mapping.amount} width={width} loaded={loaded} onChange={(amount) => setMapping({ ...mapping, amount })} />
            <Field label="金額の符号">
              <Select
                value={mapping.sign}
                onChange={(event) => setMapping({ ...mapping, sign: event.target.value as ColumnMapping['sign'] })}
                className="w-full"
              >
                <option value="positive-expense">支出がプラス</option>
                <option value="negative-expense">支出がマイナス</option>
              </Select>
            </Field>
          </div>

          {!isMappingComplete(mapping) && (
            <p className="mt-3 text-sm text-critical">列を推定できませんでした。上で指定してください。</p>
          )}

          {result && (
            <>
              <p className="mt-4 text-xs text-ink-2">
                {result.transactions.length} 件を読みました。
                {duplicates > 0 && `うち ${duplicates} 件は取り込み済みなので飛ばします。`}
                {result.skipped.length > 0 && `${result.skipped.length} 行は読めませんでした。`}
              </p>
              <Preview transactions={result.transactions} skipped={result.skipped} categories={snapshot.categories} />
            </>
          )}
        </Card>
      )}

      {!loaded && snapshot.transactions.length === 0 && (
        <EmptyState title="まだ明細がありません">
          カード会社や PayPay の管理画面から CSV をダウンロードして、ここに落としてください
        </EmptyState>
      )}
    </div>
  );
}

function ColumnSelect({
  label,
  value,
  width,
  loaded,
  onChange,
}: {
  label: string;
  value: number;
  width: number;
  loaded: Loaded;
  onChange: (value: number) => void;
}) {
  const header = loaded.rows[Math.max(0, 0)];
  return (
    <Field label={label}>
      <Select value={value} onChange={(event) => onChange(Number(event.target.value))} className="w-full">
        <option value={-1}>指定なし</option>
        {Array.from({ length: width }, (_, index) => (
          <option key={index} value={index}>
            {index + 1} 列目（{(header?.[index] ?? '').slice(0, 12) || '—'}）
          </option>
        ))}
      </Select>
    </Field>
  );
}

function Preview({
  transactions,
  skipped,
  categories,
}: {
  transactions: Transaction[];
  skipped: SkippedRow[];
  categories: Parameters<typeof categoryLabel>[0];
}) {
  return (
    <div className="mt-3 space-y-3">
      <div className="overflow-x-auto">
        <table className="w-full min-w-md text-sm">
          <thead>
            <tr className="border-b border-grid text-left text-xs text-muted">
              <th className="py-1.5 pr-2 font-medium">日付</th>
              <th className="py-1.5 pr-2 font-medium">店名</th>
              <th className="py-1.5 pr-2 font-medium">カテゴリ</th>
              <th className="py-1.5 text-right font-medium">金額</th>
            </tr>
          </thead>
          <tbody>
            {transactions.slice(0, 12).map((txn) => (
              <tr key={txn.id} className="border-b border-grid/60">
                <td className="tnum py-1.5 pr-2 whitespace-nowrap text-ink-2">{txn.date}</td>
                <td className="max-w-56 truncate py-1.5 pr-2 text-ink">{txn.rawMerchant || '（店名なし）'}</td>
                <td className="py-1.5 pr-2 text-ink-2">
                  {categoryLabel(categories, txn.splits[0].categoryId)}
                  {txn.needsDetail && <span className="ml-1 text-xs text-accent">内訳待ち</span>}
                </td>
                <td className="tnum py-1.5 text-right font-medium text-ink">{formatYen(txn.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {transactions.length > 12 && <p className="mt-2 text-xs text-muted">ほか {transactions.length - 12} 件</p>}
      </div>

      {skipped.length > 0 && (
        <details className="rounded-lg bg-plane px-3 py-2">
          <summary className="cursor-pointer text-xs text-ink-2">読めなかった {skipped.length} 行</summary>
          <ul className="mt-2 space-y-1 text-xs text-muted">
            {skipped.slice(0, 10).map((row) => (
              <li key={row.rowIndex} className="truncate">
                {row.rowIndex + 1} 行目: {row.reason}（{row.row.join(' / ').slice(0, 80)}）
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
