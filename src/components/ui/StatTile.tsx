import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

/** 1 つの数字を大きく出すだけのタイル。グラフにするほどの情報が無いものはこれで足りる */
export function StatTile({
  label,
  value,
  note,
  tone = 'neutral',
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  tone?: 'neutral' | 'good' | 'critical' | 'accent';
}) {
  return (
    <div className="rounded-xl bg-surface px-4 py-3 ring-1 ring-black/10 dark:ring-white/10">
      <p className="text-xs font-medium text-ink-2">{label}</p>
      <p
        className={cn(
          'mt-1 text-2xl font-semibold tracking-tight',
          tone === 'neutral' && 'text-ink',
          tone === 'good' && 'text-success-text',
          tone === 'critical' && 'text-critical',
          tone === 'accent' && 'text-accent',
        )}
      >
        {value}
      </p>
      {note && <p className="mt-0.5 text-xs text-muted">{note}</p>}
    </div>
  );
}
