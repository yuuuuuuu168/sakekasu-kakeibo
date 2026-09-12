import { useEffect, useState } from 'react';

/**
 * ハッシュだけのルータ。ライブラリを入れていないのは、画面が 6 枚しかないこと、
 * それに CloudFront のリライト規則が要らなくなること（#以降はサーバへ行かない）の 2 つ。
 */
export type Route =
  | { name: 'dashboard' }
  | { name: 'import' }
  | { name: 'transactions'; month?: string; filter?: string }
  | { name: 'receipts' }
  | { name: 'categories' }
  | { name: 'report'; month?: string };

export const ROUTES: { name: Route['name']; label: string; path: string }[] = [
  { name: 'dashboard', label: 'ダッシュボード', path: '#/' },
  { name: 'import', label: '取り込み', path: '#/import' },
  { name: 'transactions', label: '明細', path: '#/transactions' },
  { name: 'receipts', label: 'レシート', path: '#/receipts' },
  { name: 'report', label: 'レポート', path: '#/report' },
  { name: 'categories', label: 'カテゴリと上限', path: '#/categories' },
];

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
    case 'receipts':
      return { name: 'receipts' };
    case 'categories':
      return { name: 'categories' };
    case 'report':
      return { name: 'report', ...(params.get('month') ? { month: params.get('month') as string } : {}) };
    default:
      return { name: 'dashboard' };
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
