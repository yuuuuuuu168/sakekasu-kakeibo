import { useMemo, useState } from 'react';
import { ArrowLeftRight, CalendarClock, Check, Copy, ReceiptText, TriangleAlert } from 'lucide-react';
import {
  TRANSFER_ID,
  UNCATEGORIZED_ID,
  aggregateMonth,
  findDuplicates,
  findMisfiledTransfers,
  formatYen,
  monthOf,
  recurringStatus,
  topMerchants,
  transactionsOfMonth,
} from '@kakeibo/core';
import { useStore } from '../../api/store';
import { Badge, Button, Card, EmptyState } from '../../components/ui/primitives';
import { Meter } from '../../components/ui/Meter';
import { StatTile } from '../../components/ui/StatTile';
import { MonthPicker } from '../../components/ui/MonthPicker';
import { currentMonth, todayIso } from '../../lib/month';
import { DUPLICATES_FILTER, NEEDS_DETAIL_FILTER, navigate } from '../../lib/router';

export function DashboardPage() {
  const { snapshot, rules } = useStore();
  const [month, setMonth] = useState(currentMonth());

  const summary = useMemo(
    () =>
      aggregateMonth({
        month,
        transactions: snapshot.transactions,
        categories: snapshot.categories,
        budget: snapshot.budgets.find((budget) => budget.month === month),
        today: todayIso(),
        // 登録済みの定期支払いを渡すと、その月のまだ発生していない分が着地見込みに乗る
        recurring: snapshot.recurring,
      }),
    [month, snapshot],
  );

  const merchants = useMemo(() => topMerchants(transactionsOfMonth(snapshot.transactions, month)), [month, snapshot.transactions]);

  // ルールは取り込みのときにしか当たらないので、チャージのルールより前の分はここに出る
  const misfiled = useMemo(
    () => findMisfiledTransfers(transactionsOfMonth(snapshot.transactions, month), rules),
    [month, snapshot.transactions, rules],
  );

  // 重複は月をまたぐので探すのは全件から。出すのはこの月に掛かる組だけ
  const duplicates = useMemo(
    () =>
      findDuplicates(snapshot.transactions).filter(
        (pair) => monthOf(pair.a.date) === month || monthOf(pair.b.date) === month,
      ),
    [month, snapshot.transactions],
  );
  const rows = summary.categories.filter((row) => row.actual !== 0 || row.limit > 0);
  const overTotal = summary.categories.reduce((sum, row) => sum + row.over, 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-ink">今月の様子</h1>
        <MonthPicker month={month} onChange={setMonth} />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="支出" value={<span className="tnum">{formatYen(summary.total)}</span>} note={`${summary.transactionCount} 件`} />
        <StatTile
          label="月末の着地見込み"
          value={<span className="tnum">{formatYen(summary.projected)}</span>}
          note={
            summary.recurringRemaining > 0
              ? `うち未発生の定期 ${formatYen(summary.recurringRemaining)}`
              : summary.limitTotal > 0
                ? `上限総額 ${formatYen(summary.limitTotal)}`
                : '上限が未設定'
          }
          tone={summary.limitTotal > 0 && summary.projected > summary.limitTotal ? 'critical' : 'neutral'}
        />
        <StatTile
          label="超過している額"
          value={<span className="tnum">{formatYen(overTotal)}</span>}
          note={overTotal > 0 ? '上限を超えたカテゴリの合計' : '超過なし'}
          tone={overTotal > 0 ? 'critical' : 'good'}
        />
        <StatTile
          label="内訳待ち"
          value={<span className="tnum">{summary.needsDetailCount} 件</span>}
          note="レシートを当てれば確定する"
          tone={summary.needsDetailCount > 0 ? 'accent' : 'neutral'}
        />
      </div>

      {summary.needsDetailCount > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-accent/8 px-4 py-3 ring-1 ring-accent/20">
          <ReceiptText size={18} className="text-accent" aria-hidden />
          <p className="flex-1 text-sm text-ink">
            内訳が未確定の明細が {summary.needsDetailCount} 件。この分のカテゴリ別の数字は当てになりません。
          </p>
          <Button variant="primary" size="sm" onClick={() => navigate('#/receipts')}>
            レシートを当てる
          </Button>
          <Button size="sm" onClick={() => navigate(`#/transactions?month=${month}&filter=${NEEDS_DETAIL_FILTER}`)}>
            明細を見る
          </Button>
        </div>
      )}

      {duplicates.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-warning/12 px-4 py-3 ring-1 ring-warning/30">
          <Copy size={18} aria-hidden className="text-ink" />
          <p className="flex-1 text-sm text-ink">
            同じ支払いが二重に入っている可能性が {duplicates.length} 組。放っておくとカテゴリ別の実績が水増しされます。
          </p>
          <Button size="sm" onClick={() => navigate(`#/transactions?month=${month}&filter=${DUPLICATES_FILTER}`)}>
            確かめる
          </Button>
        </div>
      )}

      {misfiled.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-warning/12 px-4 py-3 ring-1 ring-warning/30">
          <ArrowLeftRight size={18} aria-hidden className="text-ink" />
          <p className="flex-1 text-sm text-ink">
            チャージらしい明細が {misfiled.length} 件、支出として計上されたままです。カードから残高へ移しただけの分なので、
            このままだとカテゴリ別の実績が水増しされます。
          </p>
          <Button variant="primary" size="sm" onClick={() => navigate(`#/transactions?month=${month}&filter=${TRANSFER_ID}`)}>
            振替にする
          </Button>
        </div>
      )}

      {summary.transferCount > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-plane px-4 py-3 ring-1 ring-grid">
          <ArrowLeftRight size={18} aria-hidden className="text-ink-2" />
          <p className="flex-1 text-sm text-ink-2">
            残高へのチャージ {summary.transferCount} 件・{formatYen(summary.transferTotal)} は支出から外しています。使った分は
            PayPay や Suica の利用明細のほうで数えます。
          </p>
          <Button size="sm" onClick={() => navigate(`#/transactions?month=${month}&filter=${TRANSFER_ID}`)}>
            内訳を見る
          </Button>
        </div>
      )}

      {summary.uncategorizedTotal > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-warning/12 px-4 py-3 ring-1 ring-warning/30">
          <TriangleAlert size={18} aria-hidden className="text-ink" />
          <p className="flex-1 text-sm text-ink">
            未分類が {formatYen(summary.uncategorizedTotal)}。カテゴリを付けると、以降その店は自動で同じカテゴリになります。
          </p>
          <Button size="sm" onClick={() => navigate(`#/transactions?month=${month}&filter=${UNCATEGORIZED_ID}`)}>
            片付ける
          </Button>
        </div>
      )}

      <Card title="カテゴリ別" action={<a href="#/settings" className="text-xs text-accent">上限を決める</a>}>
        {rows.length === 0 ? (
          <EmptyState title="この月の明細がありません">
            <a href="#/import" className="text-accent">
              明細を取り込む
            </a>
          </EmptyState>
        ) : (
          <ul className="space-y-3">
            {rows.map((row) => (
              <li key={row.categoryId}>
                <Meter
                  label={row.label}
                  actual={row.actual}
                  limit={row.limit}
                  detail={`着地見込み ${formatYen(row.projected)}`}
                  onClick={() => navigate(`#/transactions?month=${month}&filter=${row.categoryId}`)}
                />
                {/* 小カテゴリを作ってある大カテゴリは、中身も出す。ここが「何に散財したか」の答え */}
                {row.children && row.children.length > 0 && (
                  <ul className="mt-1 space-y-0.5 pl-3">
                    {row.children.map((child) => (
                      <li key={child.categoryId} className="flex items-baseline justify-between gap-2 text-xs text-ink-2">
                        <span className="truncate">{child.label}</span>
                        <span className="tnum shrink-0">{formatYen(child.actual)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {summary.recurringOccurrences.length > 0 && (
        <Card
          title="今月の定期的な支払い"
          action={
            <a href="#/settings" className="text-xs text-accent">
              登録を直す
            </a>
          }
        >
          <ul className="divide-y divide-grid">
            {summary.recurringOccurrences.map((occurrence) => {
              const payment = snapshot.recurring.find((item) => item.id === occurrence.paymentId);
              const status = payment ? recurringStatus(payment, todayIso()) : undefined;
              return (
                <li key={occurrence.paymentId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                  {occurrence.transactionId ? (
                    <Check size={16} className="text-success-text" aria-label="取り込み済み" />
                  ) : (
                    <CalendarClock size={16} className="text-ink-2" aria-label="これから" />
                  )}
                  <span className="text-sm text-ink">{occurrence.label}</span>
                  <span className="text-xs text-muted">{occurrence.date}</span>
                  {status?.remainingCount !== undefined && (
                    <Badge tone="neutral">
                      あと {status.remainingCount} 回
                      {status.remainingAmount !== undefined && ` / ${formatYen(status.remainingAmount)}`}
                    </Badge>
                  )}
                  <span className="flex-1" />
                  <span className="tnum text-sm font-medium text-ink">{formatYen(occurrence.amount)}</span>
                  <span className="text-xs text-muted">{occurrence.transactionId ? '取り込み済み' : '見込み'}</span>
                </li>
              );
            })}
          </ul>
          <p className="mt-3 text-xs text-muted">
            取り込み済みの分は実績に入っています。着地見込みでは二重に数えず、見込みの分だけを足しています。
          </p>
        </Card>
      )}

      {merchants.length > 0 && (
        <Card title="よく使った店">
          <ul className="divide-y divide-grid">
            {merchants.map((merchant) => (
              <li key={merchant.merchant} className="flex items-baseline justify-between gap-3 py-2">
                <span className="truncate text-sm text-ink">{merchant.rawMerchant || merchant.merchant}</span>
                <span className="shrink-0 text-xs text-muted">{merchant.count} 回</span>
                <span className="tnum shrink-0 text-sm font-medium text-ink">{formatYen(merchant.amount)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
