import { ChevronLeft, ChevronRight } from 'lucide-react';
import { currentMonth, formatMonth, shiftMonth } from '../../lib/month';

export function MonthPicker({ month, onChange }: { month: string; onChange: (month: string) => void }) {
  const atCurrent = month >= currentMonth();
  return (
    <div className="inline-flex items-center gap-1 rounded-lg bg-surface ring-1 ring-black/10 dark:ring-white/10">
      <button
        type="button"
        onClick={() => onChange(shiftMonth(month, -1))}
        className="rounded-l-lg p-1.5 text-ink-2 hover:bg-plane"
        aria-label="前の月"
      >
        <ChevronLeft size={16} />
      </button>
      <span className="tnum min-w-24 text-center text-sm font-medium text-ink">{formatMonth(month)}</span>
      <button
        type="button"
        onClick={() => onChange(shiftMonth(month, 1))}
        disabled={atCurrent}
        className="rounded-r-lg p-1.5 text-ink-2 hover:bg-plane disabled:opacity-30"
        aria-label="次の月"
      >
        <ChevronRight size={16} />
      </button>
    </div>
  );
}
