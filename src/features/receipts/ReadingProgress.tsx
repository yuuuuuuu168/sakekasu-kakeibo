import { useEffect, useState } from 'react';
import { Check, Circle, LoaderCircle } from 'lucide-react';
import { cn } from '../../lib/cn';

/** 写真を選んでから下書きが出るまでの段。送る → 読む → カテゴリを決める の順に進む */
export type ReadingStage = 'upload' | 'read' | 'classify';

export type Reading = {
  stage: ReadingStage;
  /** 送った割合（0〜1）。upload の段でだけ意味がある */
  uploaded: number;
  /** いまの段に入った時刻（Date.now()）。経過秒数をここから数える */
  stageStartedAt: number;
  /** 選んだ写真の object URL。何を送っているのかを見せる */
  previewUrl?: string;
};

const STEPS: { stage: ReadingStage; label: string }[] = [
  { stage: 'upload', label: '写真を送る' },
  { stage: 'read', label: '文字を読む' },
  { stage: 'classify', label: 'カテゴリを決める' },
];

/** 読み取りがこれより長いと、止まっていないことを言い添える */
const SLOW_SECONDS = 30;

/**
 * OCR を待つあいだの表示。ボタンが押せなくなるだけだと、送れたのか止まったのかが分からない。
 * 写真の縮小版と、いまどの段にいるか、送った割合、読み始めてからの秒数を出す。
 */
export function ReadingProgress({ reading }: { reading: Reading }) {
  const current = STEPS.findIndex((step) => step.stage === reading.stage);
  const seconds = useElapsedSeconds(reading.stageStartedAt);
  const percent = Math.round(reading.uploaded * 100);

  return (
    <div className="mt-3 flex gap-3 rounded-lg bg-plane p-3" role="status" aria-live="polite">
      {reading.previewUrl && (
        <img src={reading.previewUrl} alt="読み取り中のレシート" className="h-24 w-16 shrink-0 rounded-md object-cover ring-1 ring-black/10" />
      )}
      <div className="min-w-0 flex-1">
        <ol className="space-y-1.5 text-sm">
          {STEPS.map((step, index) => {
            const done = index < current;
            const active = index === current;
            return (
              <li key={step.stage} className={cn('flex items-center gap-2', done || active ? 'text-ink' : 'text-muted')}>
                {done ? (
                  <Check size={15} className="shrink-0 text-success-text" aria-hidden />
                ) : active ? (
                  <LoaderCircle size={15} className="shrink-0 text-accent motion-safe:animate-spin" aria-hidden />
                ) : (
                  <Circle size={15} className="shrink-0" aria-hidden />
                )}
                <span className={cn(active && 'font-medium')}>{step.label}</span>
                <span className="tnum text-xs text-muted">
                  {step.stage === 'upload' && active && `${percent}%`}
                  {step.stage === 'upload' && done && '届きました'}
                  {step.stage !== 'upload' && active && `${seconds} 秒`}
                </span>
                <span className="sr-only">{done ? '（済み）' : active ? '（実行中）' : '（待ち）'}</span>
              </li>
            );
          })}
        </ol>
        {reading.stage === 'upload' && (
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-grid" aria-hidden>
            <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${percent}%` }} />
          </div>
        )}
        <p className="mt-2 text-xs text-ink-2">
          {reading.stage === 'upload'
            ? '写真を送っています。電波の弱いところでは時間がかかります。'
            : seconds >= SLOW_SECONDS
              ? '時間がかかっていますが、まだ読んでいます。このままお待ちください。'
              : '写真は届いています。読み取りにはふつう 10〜20 秒ほどかかります。'}
        </p>
      </div>
    </div>
  );
}

/** since からの経過秒数。1 秒ごとに描き直す */
function useElapsedSeconds(since: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return Math.max(0, Math.floor((now - since) / 1000));
}
