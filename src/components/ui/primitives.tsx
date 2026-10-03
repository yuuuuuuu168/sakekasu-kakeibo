import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

export function Card({ children, className, title, action }: { children: ReactNode; className?: string; title?: ReactNode; action?: ReactNode }) {
  return (
    <section className={cn('rounded-xl bg-surface ring-1 ring-black/10 dark:ring-white/10', className)}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b border-grid px-4 py-3">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          {action}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
};

export function Button({ variant = 'ghost', size = 'md', className, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-sm',
        variant === 'primary' && 'bg-accent text-accent-ink hover:brightness-110',
        variant === 'ghost' && 'bg-plane text-ink ring-1 ring-black/10 hover:bg-grid dark:ring-white/10',
        variant === 'danger' && 'bg-plane text-critical ring-1 ring-critical/40 hover:bg-critical/10',
        className,
      )}
    />
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...rest}
      className={cn(
        'w-full rounded-lg bg-plane px-2.5 py-1.5 text-sm text-ink ring-1 ring-black/10 placeholder:text-muted dark:ring-white/10',
        className,
      )}
    />
  );
}

export function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...rest}
      className={cn('rounded-lg bg-plane px-2 py-1.5 text-sm text-ink ring-1 ring-black/10 dark:ring-white/10', className)}
    />
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-ink-2">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'good' | 'warning' | 'critical' | 'accent' }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium',
        tone === 'neutral' && 'bg-grid text-ink-2',
        tone === 'good' && 'bg-good/12 text-success-text',
        tone === 'warning' && 'bg-warning/20 text-ink',
        tone === 'critical' && 'bg-critical/12 text-critical',
        tone === 'accent' && 'bg-accent/12 text-accent',
      )}
    >
      {children}
    </span>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-axis px-4 py-8 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      {children && <div className="mt-1 text-xs text-ink-2">{children}</div>}
    </div>
  );
}
