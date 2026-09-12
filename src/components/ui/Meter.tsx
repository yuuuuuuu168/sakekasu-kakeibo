import { Check, CircleAlert, Flame, Minus, TriangleAlert } from 'lucide-react';
import { formatYen } from '@kakeibo/core';
import { cn } from '../../lib/cn';

export type MeterStatus = 'none' | 'good' | 'warning' | 'serious' | 'critical';

export function meterStatus(actual: number, limit: number): MeterStatus {
  if (limit <= 0) return 'none';
  const usage = actual / limit;
  if (usage < 0.8) return 'good';
  if (usage <= 1) return 'warning';
  if (usage <= 1.5) return 'serious';
  return 'critical';
}

const FILL: Record<MeterStatus, string> = {
  none: 'bg-axis',
  good: 'bg-good',
  warning: 'bg-warning',
  serious: 'bg-serious',
  critical: 'bg-critical',
};

const LABEL: Record<MeterStatus, string> = {
  none: '上限なし',
  good: '余裕あり',
  warning: '残り少ない',
  serious: '超過',
  critical: '大幅に超過',
};

function StatusIcon({ status }: { status: MeterStatus }) {
  const size = 13;
  if (status === 'good') return <Check size={size} aria-hidden />;
  if (status === 'warning') return <TriangleAlert size={size} aria-hidden />;
  if (status === 'serious') return <CircleAlert size={size} aria-hidden />;
  if (status === 'critical') return <Flame size={size} aria-hidden />;
  return <Minus size={size} aria-hidden />;
}

/**
 * 上限に対する消化を 1 本の横棒で出す。
 * 色だけに意味を持たせないよう、アイコンと「余裕あり / 超過」の文字を必ず添える。
 * 超過分は上限の位置で 2px 空けて区切り、超えたことが形でも分かるようにする。
 */
export function Meter({
  label,
  actual,
  limit,
  detail,
  onClick,
}: {
  label: string;
  actual: number;
  limit: number;
  detail?: string;
  onClick?: () => void;
}) {
  const status = meterStatus(actual, limit);
  const remaining = limit - actual;
  const over = actual > limit && limit > 0;

  /*
   * 上限内なら棒の長さは actual / limit。track の残りが余裕になる。
   * 超えたら棒は満杯にして、上限の位置（limit / actual）で 2px 空けて区切る。
   * 超過分を「上限をもう 1 本ぶん」として足すと、3 倍使っても 2 倍使ったときと
   * 同じ見た目になり、しかも棒が半分ずつに割れて「半分は上限内」と読めてしまう。
   */
  const withinWidth = limit <= 0 ? 0 : over ? (limit / actual) * 100 : Math.min(actual / limit, 1) * 100;
  const overWidth = over ? ((actual - limit) / actual) * 100 : 0;

  const Wrapper = onClick ? 'button' : 'div';

  return (
    <Wrapper
      {...(onClick ? { type: 'button' as const, onClick } : {})}
      className={cn('block w-full text-left', onClick && 'rounded-lg hover:bg-plane')}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-sm text-ink">{label}</span>
        <span className="tnum shrink-0 text-sm font-semibold text-ink">{formatYen(actual)}</span>
      </div>

      <div className="mt-1.5 flex h-2.5 w-full items-stretch overflow-hidden rounded-full bg-grid" role="presentation">
        <div
          className={cn('rounded-full', over ? 'bg-axis' : FILL[status])}
          style={{ width: `${withinWidth}%`, minWidth: actual > 0 ? 4 : 0 }}
        />
        {overWidth > 0 && (
          <>
            {/* 上限の位置。ここから右が超過分 */}
            <div className="w-0.5 shrink-0 bg-surface" />
            <div className={cn('rounded-full', FILL[status])} style={{ width: `${overWidth}%`, minWidth: 4 }} />
          </>
        )}
      </div>

      <div className="mt-1 flex items-center justify-between gap-2 text-xs">
        <span
          className={cn(
            'inline-flex items-center gap-1',
            status === 'good' && 'text-success-text',
            status === 'warning' && 'text-ink-2',
            status === 'serious' && 'text-ink-2',
            status === 'critical' && 'text-critical',
            status === 'none' && 'text-muted',
          )}
        >
          <StatusIcon status={status} />
          {LABEL[status]}
        </span>
        <span className="tnum text-ink-2">
          {limit > 0
            ? remaining >= 0
              ? `上限 ${formatYen(limit)} / 残り ${formatYen(remaining)}`
              : `上限 ${formatYen(limit)} / 超過 ${formatYen(-remaining)}`
            : (detail ?? '上限が未設定')}
        </span>
      </div>
    </Wrapper>
  );
}
