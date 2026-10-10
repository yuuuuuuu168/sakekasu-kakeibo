import { useEffect, useMemo, useState } from 'react';
import { Award, Flame, ThumbsUp, TriangleAlert, Zap } from 'lucide-react';
import { confirmPayment, findUnverifiedPayments, formatYen, type MonthlyReport, type ScoldLevel } from '@kakeibo/core';
import { api } from '../../api/index';
import { useStore } from '../../api/store';
import { Button, Card, EmptyState } from '../../components/ui/primitives';
import { MonthPicker } from '../../components/ui/MonthPicker';
import { StatTile } from '../../components/ui/StatTile';
import { currentMonth, formatMonth, shiftMonth } from '../../lib/month';
import { cn } from '../../lib/cn';

const SCOLD_ICON: Record<ScoldLevel, typeof Award> = {
  0: Award,
  1: ThumbsUp,
  2: TriangleAlert,
  3: Zap,
  4: Flame,
};

/** 叱りの見た目。色だけでなくアイコンと段位の名前も出す */
const SCOLD_STYLE: Record<ScoldLevel, string> = {
  0: 'bg-good/12 text-success-text ring-good/30',
  1: 'bg-plane text-ink ring-black/10 dark:ring-white/10',
  2: 'bg-warning/15 text-ink ring-warning/30',
  3: 'bg-serious/15 text-ink ring-serious/40',
  4: 'bg-critical/12 text-critical ring-critical/40',
};

export function ReportPage({ month: initialMonth }: { month?: string }) {
  // 既定は前月。月末に締めたものを読む画面なので
  const [month, setMonth] = useState(initialMonth ?? shiftMonth(currentMonth(), -1));
  const [report, setReport] = useState<MonthlyReport | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const { snapshot, loading: storeLoading, saveTransaction } = useStore();

  /**
   * レポートは月初に作って保存したものなので、後からレシートを当てたり「身に覚えあり」と
   * 言ったりした分は中に残っている。今の明細とレシートで確かめ直し、まだ残るものだけを出す
   */
  const unverified = useMemo(() => {
    const listed = report?.unverified ?? [];
    if (storeLoading) return listed;
    const stillOpen = new Set(
      findUnverifiedPayments({ month, transactions: snapshot.transactions, receipts: snapshot.receipts, recurring: snapshot.recurring }).map(
        (payment) => payment.id,
      ),
    );
    return listed.filter((payment) => stillOpen.has(payment.id));
  }, [report, storeLoading, month, snapshot.transactions, snapshot.receipts, snapshot.recurring]);

  async function confirmOne(id: string) {
    const txn = snapshot.transactions.find((item) => item.id === id);
    if (!txn) return;
    try {
      await saveTransaction(confirmPayment(txn));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .getReport(month)
      .then((result) => {
        if (alive) {
          setReport(result);
          setError(undefined);
        }
      })
      .catch((cause: unknown) => {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [month]);

  const Icon = report ? SCOLD_ICON[report.scolding.level] : Award;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-ink">{formatMonth(month)}のレポート</h1>
        <MonthPicker month={month} onChange={setMonth} />
      </div>

      {error && <p className="rounded-lg bg-critical/12 px-3 py-2 text-sm text-critical">{error}</p>}
      {loading && <p className="py-8 text-center text-sm text-ink-2">読み込み中…</p>}

      {!loading && !report && (
        <EmptyState title="この月のレポートはまだありません">
          レポートは毎月 1 日に前月分が作られます
        </EmptyState>
      )}

      {!loading && report && (
        <>
          <div className={cn('rounded-xl px-4 py-4 ring-1', SCOLD_STYLE[report.scolding.level])}>
            <div className="flex items-center gap-2">
              <Icon size={20} aria-hidden />
              <h2 className="text-xl font-bold">{report.scolding.title}</h2>
            </div>
            <div className="mt-2 space-y-1">
              {report.scolding.lines.map((line) => (
                <p key={line} className="text-sm">
                  {line}
                </p>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile label="支出" value={<span className="tnum">{formatYen(report.total)}</span>} />
            <StatTile
              label="上限総額"
              value={<span className="tnum">{report.hasLimits ? formatYen(report.limitTotal) : '—'}</span>}
              note={report.hasLimits ? undefined : 'カテゴリ設定から決める'}
            />
            <StatTile
              label="超過"
              value={<span className="tnum">{formatYen(report.overTotal)}</span>}
              tone={report.overTotal > 0 ? 'critical' : 'good'}
            />
            <StatTile
              label="前月との差"
              value={
                <span className="tnum">
                  {report.deltaFromPrevious === undefined
                    ? '—'
                    : `${report.deltaFromPrevious >= 0 ? '+' : ''}${formatYen(report.deltaFromPrevious)}`}
                </span>
              }
              note={report.previousTotal === undefined ? '前月の明細なし' : `前月 ${formatYen(report.previousTotal)}`}
              tone={report.deltaFromPrevious !== undefined && report.deltaFromPrevious > 0 ? 'critical' : 'good'}
            />
          </div>

          {unverified.length > 0 && (
            <Card title={`これ大丈夫？ ${unverified.length} 件`}>
              <p className="text-xs text-ink-2">
                {'レシートとも定期的な支払いとも突き合わなかったカード・PayPay の支払いです。利用日と金額で照らしています。' +
                  '身に覚えが無ければ、カード会社か PayPay に問い合わせてください。'}
              </p>
              <ul className="mt-2 divide-y divide-grid">
                {unverified.map((payment) => (
                  <li key={payment.id} className="py-2">
                    {/* 店名がこの確かめの肝なので、狭い画面でも削られないよう 1 段を明け渡す */}
                    <div className="flex items-baseline gap-2">
                      <span className="tnum shrink-0 text-xs text-muted">{payment.date.slice(5)}</span>
                      <span className="min-w-0 flex-1 break-all text-sm text-ink">{payment.rawMerchant}</span>
                    </div>
                    <div className="mt-1 flex items-center justify-end gap-3">
                      <span className="text-xs text-muted">{payment.sourceLabel}</span>
                      <span className="tnum text-sm font-medium text-ink">{formatYen(payment.amount)}</span>
                      <Button size="sm" onClick={() => void confirmOne(payment.id)} disabled={storeLoading}>
                        身に覚えあり
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card title="カテゴリ別">
            <div className="overflow-x-auto">
              <table className="w-full min-w-md text-sm">
                <thead>
                  <tr className="border-b border-grid text-left text-xs text-muted">
                    <th className="py-1.5 pr-2 font-medium">カテゴリ</th>
                    <th className="py-1.5 pr-2 text-right font-medium">実績</th>
                    <th className="py-1.5 pr-2 text-right font-medium">上限</th>
                    <th className="py-1.5 text-right font-medium">差</th>
                  </tr>
                </thead>
                <tbody>
                  {report.categories
                    .filter((row) => row.actual !== 0 || row.limit > 0)
                    .map((row) => (
                      <tr key={row.categoryId} className="border-b border-grid/60">
                        <td className="py-1.5 pr-2 text-ink">{row.label}</td>
                        <td className="tnum py-1.5 pr-2 text-right text-ink">{formatYen(row.actual)}</td>
                        <td className="tnum py-1.5 pr-2 text-right text-ink-2">{row.limit > 0 ? formatYen(row.limit) : '—'}</td>
                        <td
                          className={cn(
                            'tnum py-1.5 text-right font-medium',
                            row.over > 0 ? 'text-critical' : row.limit > 0 ? 'text-success-text' : 'text-muted',
                          )}
                        >
                          {row.limit > 0 ? (row.over > 0 ? `+${formatYen(row.over)}` : formatYen(row.limit - row.actual)) : '—'}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </Card>

          {report.topMerchants.length > 0 && (
            <Card title="使った額の多い店">
              <ul className="divide-y divide-grid">
                {report.topMerchants.map((merchant) => (
                  <li key={merchant.merchant} className="flex items-baseline justify-between gap-3 py-2">
                    <span className="truncate text-sm text-ink">{merchant.rawMerchant || merchant.merchant}</span>
                    <span className="shrink-0 text-xs text-muted">{merchant.count} 回</span>
                    <span className="tnum shrink-0 text-sm font-medium text-ink">{formatYen(merchant.amount)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {report.needsDetailCount > 0 && (
            <p className="text-xs text-muted">
              内訳が未確定の明細が {report.needsDetailCount} 件残っています。レシートを当てると、カテゴリ別の数字が変わります。
            </p>
          )}
        </>
      )}
    </div>
  );
}
