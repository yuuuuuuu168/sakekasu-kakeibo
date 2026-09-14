import { useMemo, useState } from 'react';
import { Pause, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import {
  activeCategories,
  categoryLabel,
  formatYen,
  recurringStatus,
  type Category,
  type RecurringPayment,
} from '@kakeibo/core';
import { useStore } from '../../api/store';
import { Badge, Button, Card, EmptyState, Field, Input, Select } from '../../components/ui/primitives';
import { currentMonth, formatMonth, todayIso } from '../../lib/month';

const INTERVALS: { value: number; label: string }[] = [
  { value: 1, label: '毎月' },
  { value: 2, label: '2 か月ごと' },
  { value: 3, label: '3 か月ごと' },
  { value: 6, label: '半年ごと' },
  { value: 12, label: '年 1 回' },
];

/**
 * 定期的な支払いの登録。サブスク、分割、奨学金のように金額と周期が分かっているもの。
 *
 * ここで登録しても明細は生えない。取り込んだ明細と必ず重なるからで、代わりに着地見込みと
 * 残り回数の材料にする。取り込んだ明細のうち店舗名と金額が合うものは「取り込み済み」として
 * 印が付き、見込みでは二重に数えない（packages/core の aggregateMonth）。
 */
export function RecurringPayments() {
  const { snapshot, saveRecurring } = useStore();
  const [editing, setEditing] = useState<RecurringPayment | 'new' | undefined>();
  const categories = activeCategories(snapshot.categories);
  const today = todayIso();

  const rows = useMemo(() => {
    return snapshot.recurring
      .map((payment) => ({ payment, status: recurringStatus(payment, today) }))
      .sort((a, b) => {
        if (a.status.finished !== b.status.finished) return a.status.finished ? 1 : -1;
        return (a.status.nextDate ?? '9999').localeCompare(b.status.nextDate ?? '9999');
      });
  }, [snapshot.recurring, today]);

  const monthlyTotal = rows
    .filter(({ payment, status }) => !payment.archived && !status.finished)
    .reduce((sum, { payment }) => sum + Math.round(payment.amount / Math.max(1, payment.intervalMonths ?? 1)), 0);

  async function save(payment: RecurringPayment) {
    const exists = snapshot.recurring.some((item) => item.id === payment.id);
    await saveRecurring(exists ? snapshot.recurring.map((item) => (item.id === payment.id ? payment : item)) : [...snapshot.recurring, payment]);
    setEditing(undefined);
  }

  async function toggleArchived(payment: RecurringPayment) {
    await saveRecurring(snapshot.recurring.map((item) => (item.id === payment.id ? { ...item, archived: !item.archived } : item)));
  }

  async function remove(payment: RecurringPayment) {
    if (!window.confirm(`${payment.label} を消します。過去の月の見込みも再現できなくなります。`)) return;
    await saveRecurring(snapshot.recurring.filter((item) => item.id !== payment.id));
  }

  return (
    <Card
      title="定期的な支払い"
      action={
        <div className="flex items-center gap-2">
          {monthlyTotal > 0 && <span className="tnum text-sm text-ink-2">月あたり {formatYen(monthlyTotal)}</span>}
          <Button size="sm" variant="primary" onClick={() => setEditing('new')} disabled={editing === 'new'}>
            <Plus size={14} aria-hidden />
            追加
          </Button>
        </div>
      }
    >
      {rows.length === 0 && editing === undefined ? (
        <EmptyState title="まだ登録がありません">
          サブスクや分割払いを入れておくと、着地見込みに先に入り、あと何回かが分かります。
        </EmptyState>
      ) : (
        <ul className="divide-y divide-grid">
          {rows.map(({ payment, status }) => (
            <li key={payment.id} className="py-3">
              {editing !== 'new' && editing?.id === payment.id ? (
                <RecurringForm
                  categories={categories}
                  initial={payment}
                  onCancel={() => setEditing(undefined)}
                  onSave={save}
                />
              ) : (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-medium text-ink">{payment.label}</span>
                  <span className="tnum text-sm text-ink">{formatYen(payment.amount)}</span>
                  <span className="text-xs text-ink-2">{categoryLabel(snapshot.categories, payment.categoryId)}</span>
                  <span className="text-xs text-muted">
                    {INTERVALS.find((item) => item.value === (payment.intervalMonths ?? 1))?.label ?? '毎月'} {payment.dayOfMonth} 日
                  </span>
                  {payment.variableAmount && <Badge>金額は目安</Badge>}
                  <span className="flex-1" />
                  <RemainingLabel payment={payment} status={status} />
                  <div className="flex items-center gap-1">
                    <Button size="sm" onClick={() => setEditing(payment)} aria-label={`${payment.label} を編集`}>
                      <Pencil size={14} aria-hidden />
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => void toggleArchived(payment)}
                      aria-label={payment.archived ? `${payment.label} を再開` : `${payment.label} を停止`}
                    >
                      {payment.archived ? <Play size={14} aria-hidden /> : <Pause size={14} aria-hidden />}
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => void remove(payment)} aria-label={`${payment.label} を削除`}>
                      <Trash2 size={14} aria-hidden />
                    </Button>
                  </div>
                  {status.finished && !payment.archived && <Badge tone="neutral">支払い終了</Badge>}
                  {payment.archived && <Badge tone="neutral">停止中</Badge>}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {editing === 'new' && (
        <div className="mt-3 border-t border-grid pt-3">
          <RecurringForm categories={categories} onCancel={() => setEditing(undefined)} onSave={save} />
        </div>
      )}
    </Card>
  );
}

function RemainingLabel({ payment, status }: { payment: RecurringPayment; status: ReturnType<typeof recurringStatus> }) {
  if (payment.archived) return <span className="text-xs text-muted">停止中</span>;
  if (status.finished) return <span className="text-xs text-muted">{status.lastMonth && `${formatMonth(status.lastMonth)} で終了`}</span>;

  return (
    <span className="text-xs text-ink-2">
      次は {status.nextDate}
      {status.remainingCount !== undefined && (
        <>
          {' ・ '}
          <span className="tnum">
            あと {status.remainingCount} 回
            {status.remainingAmount !== undefined && ` / ${formatYen(status.remainingAmount)}`}
          </span>
        </>
      )}
    </span>
  );
}

type Draft = {
  label: string;
  amount: string;
  categoryId: string;
  dayOfMonth: string;
  startMonth: string;
  intervalMonths: string;
  totalCount: string;
  endMonth: string;
  totalAmount: string;
  merchantPattern: string;
  variableAmount: boolean;
};

function toDraft(payment: RecurringPayment | undefined, categories: Category[]): Draft {
  return {
    label: payment?.label ?? '',
    amount: payment ? String(payment.amount) : '',
    categoryId: payment?.categoryId ?? categories[0]?.id ?? 'uncategorized',
    dayOfMonth: String(payment?.dayOfMonth ?? 27),
    startMonth: payment?.startMonth ?? currentMonth(),
    intervalMonths: String(payment?.intervalMonths ?? 1),
    totalCount: payment?.totalCount === undefined ? '' : String(payment.totalCount),
    endMonth: payment?.endMonth ?? '',
    totalAmount: payment?.totalAmount === undefined ? '' : String(payment.totalAmount),
    merchantPattern: payment?.merchantPattern ?? '',
    variableAmount: payment?.variableAmount ?? false,
  };
}

/** 空欄は「決めていない」。0 や空文字をそのまま入れると終わりが決まったことになってしまう */
function optionalNumber(value: string): number | undefined {
  const parsed = Math.round(Number(value));
  return value.trim() === '' || !Number.isFinite(parsed) || parsed <= 0 ? undefined : parsed;
}

function RecurringForm({
  categories,
  initial,
  onCancel,
  onSave,
}: {
  categories: Category[];
  initial?: RecurringPayment;
  onCancel: () => void;
  onSave: (payment: RecurringPayment) => Promise<void>;
}) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(initial, categories));
  const [busy, setBusy] = useState(false);

  const amount = Math.round(Number(draft.amount));
  const valid = draft.label.trim() !== '' && Number.isFinite(amount) && amount > 0 && /^\d{4}-\d{2}$/.test(draft.startMonth);

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function submit() {
    if (!valid || busy) return;
    setBusy(true);
    try {
      const totalCount = optionalNumber(draft.totalCount);
      const totalAmount = optionalNumber(draft.totalAmount);
      const payment: RecurringPayment = {
        id: initial?.id ?? `rp-${Date.now().toString(36)}`,
        label: draft.label.trim(),
        amount,
        categoryId: draft.categoryId,
        dayOfMonth: Math.min(31, Math.max(1, Math.round(Number(draft.dayOfMonth)) || 1)),
        startMonth: draft.startMonth,
        intervalMonths: Math.max(1, Math.round(Number(draft.intervalMonths)) || 1),
        ...(totalCount === undefined ? {} : { totalCount }),
        ...(/^\d{4}-\d{2}$/.test(draft.endMonth) ? { endMonth: draft.endMonth } : {}),
        ...(totalAmount === undefined ? {} : { totalAmount }),
        ...(draft.merchantPattern.trim() === '' ? {} : { merchantPattern: draft.merchantPattern.trim() }),
        ...(draft.variableAmount ? { variableAmount: true } : {}),
        ...(initial?.archived ? { archived: true } : {}),
      };
      await onSave(payment);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="名前">
          <Input value={draft.label} onChange={(event) => set('label', event.target.value)} placeholder="Netflix、iPhone の分割" />
        </Field>
        <Field label="金額">
          <Input
            type="number"
            inputMode="numeric"
            className="tnum"
            value={draft.amount}
            onChange={(event) => set('amount', event.target.value)}
            placeholder="1590"
          />
        </Field>
        <Field label="カテゴリ">
          <Select className="w-full" value={draft.categoryId} onChange={(event) => set('categoryId', event.target.value)}>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="引き落とし日">
          <Input
            type="number"
            inputMode="numeric"
            className="tnum"
            min={1}
            max={31}
            value={draft.dayOfMonth}
            onChange={(event) => set('dayOfMonth', event.target.value)}
          />
        </Field>
        <Field label="周期">
          <Select className="w-full" value={draft.intervalMonths} onChange={(event) => set('intervalMonths', event.target.value)}>
            {INTERVALS.map((interval) => (
              <option key={interval.value} value={interval.value}>
                {interval.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="初回の月">
          <Input type="month" value={draft.startMonth} onChange={(event) => set('startMonth', event.target.value)} />
        </Field>
        <Field label="回数" hint="終わりが決まっているものだけ">
          <Input
            type="number"
            inputMode="numeric"
            className="tnum"
            value={draft.totalCount}
            onChange={(event) => set('totalCount', event.target.value)}
            placeholder="24"
          />
        </Field>
        <Field label="最終月" hint="回数の代わりでもよい">
          <Input type="month" value={draft.endMonth} onChange={(event) => set('endMonth', event.target.value)} />
        </Field>
        <Field label="総額" hint="奨学金など。残額の表示に使う">
          <Input
            type="number"
            inputMode="numeric"
            className="tnum"
            value={draft.totalAmount}
            onChange={(event) => set('totalAmount', event.target.value)}
            placeholder="158400"
          />
        </Field>
        <Field label="明細に出る店舗名" hint="空なら名前で照合する">
          <Input
            value={draft.merchantPattern}
            onChange={(event) => set('merchantPattern', event.target.value)}
            placeholder="NETFLIX.COM"
          />
        </Field>
      </div>

      <label className="flex items-center gap-2 text-sm text-ink">
        <input
          type="checkbox"
          checked={draft.variableAmount}
          onChange={(event) => set('variableAmount', event.target.checked)}
          className="size-4"
        />
        毎回の金額が動く（電気代など）。金額は目安として扱い、明細が来たらその額で見込む
      </label>

      <div className="flex items-center gap-2">
        <Button variant="primary" onClick={() => void submit()} disabled={!valid || busy}>
          保存する
        </Button>
        <Button onClick={onCancel} disabled={busy}>
          やめる
        </Button>
      </div>
    </div>
  );
}
