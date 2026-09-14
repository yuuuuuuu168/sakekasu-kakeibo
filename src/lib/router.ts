import { useEffect, useState } from 'react';

/**
 * ハッシュだけのルータ。ライブラリを入れていないのは、画面が 6 枚しかないこと、
 * それに CloudFront のリライト規則が要らなくなること（#以降はサーバへ行かない）の 2 つ。
 * タブに出すのは 5 枚で、設定（カテゴリと上限）は歯車から開く。
 */
export type Route =
  | { name: 'receipts' }
  | { name: 'transactions'; month?: string; filter?: string }
  | { name: 'import' }
  | { name: 'dashboard' }
  | { name: 'report'; month?: string }
  | { name: 'settings' };

/** 上部のタブ。左から使う順に並べる。既定（`#/`）はレシート。 */
export const ROUTES: { name: Route['name']; label: string; path: string }[] = [
  { name: 'receipts', label: 'レシート', path: '#/' },
  { name: 'transactions', label: '明細', path: '#/transactions' },
  { name: 'import', label: '明細取り込み', path: '#/import' },
  { name: 'dashboard', label: 'ダッシュボード', path: '#/dashboard' },
  { name: 'report', label: 'レポート', path: '#/report' },
];

export const SETTINGS_PATH = '#/settings';

/**
 * 明細一覧の `filter` に渡す、組み込みの絞り込み。カテゴリ ID と同じ場所に入るので、
 * カテゴリ ID にはならない名前にしてある。
 */
export const NEEDS_DETAIL_FILTER = 'needsDetail';
export const DUPLICATES_FILTER = 'duplicates';

export function parseHash(hash: string): Route {
  const [path, query] = hash.replace(/^#\/?/, '').split('?');
  const params = new URLSearchParams(query ?? '');
  const segment = path.split('/')[0];

  switch (segment) {
    case 'import':
      return { name: 'import' };
    case 'transactions':
      return {
        name: 'transactions',
        ...(params.get('month') ? { month: params.get('month') as string } : {}),
        ...(params.get('filter') ? { filter: params.get('filter') as string } : {}),
      };
    case 'dashboard':
      return { name: 'dashboard' };
    case 'report':
      return { name: 'report', ...(params.get('month') ? { month: params.get('month') as string } : {}) };
    // `categories` も設定へ送る。タブから外す前に貼ったブックマークを切らないため。
    case 'settings':
    case 'categories':
      return { name: 'settings' };
    default:
      return { name: 'receipts' };
  }
}

export function navigate(path: string): void {
  window.location.hash = path.startsWith('#') ? path : `#${path}`;
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));

  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  return route;
}
