import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '../../lib/cn';

/**
 * 画面の上に出す知らせの帯。info は操作の結果、error は失敗。
 * error は role="alert" で読み上げさせる。閉じられるのは onDismiss を渡したときだけ
 */
export function Notice({
  tone = 'info',
  children,
  className,
  onDismiss,
}: {
  tone?: 'info' | 'error';
  children: ReactNode;
  className?: string;
  onDismiss?: () => void;
}) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-2 rounded-lg px-3 py-2 text-sm',
        tone === 'error' ? 'bg-critical/12 text-critical' : 'bg-plane text-ink',
        className,
      )}
    >
      <div className="min-w-0 flex-1">{children}</div>
      {onDismiss && (
        <button type="button" onClick={onDismiss} aria-label="閉じる" className="-m-0.5 rounded p-0.5 hover:bg-black/5 dark:hover:bg-white/10">
          <X size={14} />
        </button>
      )}
    </div>
  );
}
