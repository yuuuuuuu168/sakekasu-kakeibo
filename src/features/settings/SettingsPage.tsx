import { useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../../lib/cn';
import { CategoriesPage } from '../categories/CategoriesPage';
import { LearnedRules } from '../rules/LearnedRules';
import { RecurringPayments } from '../recurring/RecurringPayments';

/** 開いている節は覚えておく。次に設定を開いたとき、いつも触る節だけが開いた状態で始まる */
const OPEN_KEY = 'sakekasu-kakeibo:settings-open';

type SectionId = 'categories' | 'recurring' | 'rules';

const SECTIONS: { id: SectionId; title: string; description: string; render: () => ReactNode }[] = [
  { id: 'categories', title: 'カテゴリと上限', description: '月ごとの上限、カテゴリの追加・並べ替え', render: () => <CategoriesPage /> },
  { id: 'recurring', title: '定期的な支払い', description: 'サブスクや分割払いの登録', render: () => <RecurringPayments /> },
  { id: 'rules', title: '覚えたカテゴリ', description: '品目名・店名から自動で当てるカテゴリ', render: () => <LearnedRules /> },
];

function loadOpen(): SectionId[] {
  try {
    const raw = window.localStorage.getItem(OPEN_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is SectionId => SECTIONS.some((section) => section.id === id)) : [];
  } catch {
    return [];
  }
}

function storeOpen(open: SectionId[]) {
  try {
    window.localStorage.setItem(OPEN_KEY, JSON.stringify(open));
  } catch {
    // 覚えられなくても開閉はできる
  }
}

/**
 * 設定。タブからは外して、ヘッダの歯車から開く。
 * 項目が増えてスクロールが長くなったので、節ごとに見出しを押して開閉する。最初は全部閉じている。
 * 中身は既存の画面をそのまま入れているだけで、カテゴリと上限の操作は CategoriesPage が、
 * 定期的な支払いは RecurringPayments が、覚えたカテゴリ（品目・店名のルール）は LearnedRules が持つ。
 * 閉じた節も描画は残し（hidden で隠すだけ）、書きかけの入力が開閉で消えないようにしている。
 * サインアウトはヘッダの右上（SignOutButton）にある。
 */
export function SettingsPage() {
  const [open, setOpen] = useState<SectionId[]>(loadOpen);

  function toggle(id: SectionId) {
    const next = open.includes(id) ? open.filter((item) => item !== id) : [...open, id];
    setOpen(next);
    storeOpen(next);
  }

  function setAll(expand: boolean) {
    const next = expand ? SECTIONS.map((section) => section.id) : [];
    setOpen(next);
    storeOpen(next);
  }

  const allOpen = open.length === SECTIONS.length;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-ink">設定</h1>
        <button type="button" onClick={() => setAll(!allOpen)} className="text-xs font-medium text-accent hover:underline">
          {allOpen ? 'すべて閉じる' : 'すべて開く'}
        </button>
      </div>

      {SECTIONS.map((section) => {
        const expanded = open.includes(section.id);
        const panelId = `settings-${section.id}`;
        return (
          <section key={section.id}>
            <h2>
              <button
                type="button"
                aria-expanded={expanded}
                aria-controls={panelId}
                onClick={() => toggle(section.id)}
                className="flex w-full items-center gap-3 rounded-xl bg-surface px-4 py-3 text-left ring-1 ring-black/10 hover:bg-plane dark:ring-white/10"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-base font-semibold text-ink">{section.title}</span>
                  <span className="block text-xs text-muted">{section.description}</span>
                </span>
                <ChevronDown
                  size={18}
                  aria-hidden
                  className={cn('shrink-0 text-ink-2 transition-transform', expanded && 'rotate-180')}
                />
              </button>
            </h2>
            {/* 中身はそれぞれがカードを持っているので、ここでは囲まずに見出しの下へ並べる */}
            <div id={panelId} hidden={!expanded} className="mt-3 mb-6">
              {section.render()}
            </div>
          </section>
        );
      })}
    </div>
  );
}
