import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/cn';

/**
 * 画面の上のほうに出す、片付けを促す一文とボタンの帯。ダッシュボードと明細で同じ形にそろえる。
 * 狭い画面では文が細い柱にならないよう、文に最低幅を持たせ、入らなければボタンを次の行へ送る。
 * tone は地の色だけを変える（accent は内訳待ち、warning は水増しの恐れ、neutral は知らせるだけ）
 */
export function Callout({
  icon: Icon,
  tone = 'neutral',
  children,
  actions,
}: {
  icon: LucideIcon;
  tone?: 'accent' | 'warning' | 'neutral';
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl px-4 py-3 ring-1',
        tone === 'accent' && 'bg-accent/8 ring-accent/20',
        tone === 'warning' && 'bg-warning/12 ring-warning/30',
        tone === 'neutral' && 'bg-plane ring-grid',
      )}
    >
      <div className="flex min-w-0 flex-1 basis-64 items-start gap-3">
        <Icon size={18} aria-hidden className={cn('mt-0.5 shrink-0', tone === 'accent' ? 'text-accent' : 'text-ink-2')} />
        <p className={cn('min-w-0 flex-1 text-sm leading-relaxed', tone === 'neutral' ? 'text-ink-2' : 'text-ink')}>{children}</p>
      </div>
      {actions && <div className="ml-auto flex shrink-0 flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
