import { X } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';

/** 小さなモーダル。ライブラリを足さずに済む範囲で、Esc と背景クリックだけ面倒を見る */
export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-label={title}
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-surface shadow-xl sm:rounded-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="sticky top-0 flex items-center justify-between border-b border-grid bg-surface px-4 py-3">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          <button type="button" onClick={onClose} aria-label="閉じる" className="rounded-md p-1 text-ink-2 hover:bg-plane">
            <X size={16} />
          </button>
        </header>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}
