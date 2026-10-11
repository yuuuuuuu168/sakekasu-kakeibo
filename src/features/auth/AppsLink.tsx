import { LayoutGrid } from 'lucide-react';
import { APPS_URL } from './signOutRedirect';

/**
 * ヘッダ右上、歯車の左に置く「アプリ一覧」。ポータルのアプリ一覧へ同じタブで移り、
 * ほかの 3 アプリへ行き来できるようにする。サインアウトのボタンと同じ見た目にそろえ、
 * 狭い画面ではアイコンだけにして文字は sm 以上で出す。
 * ローカルモードでも出す（行き先はポータルなので、手元のデータには関係しない）。
 */
export function AppsLink() {
  return (
    <a
      href={APPS_URL}
      aria-label="アプリ一覧"
      title="アプリ一覧"
      className="flex items-center gap-1 rounded-md p-1.5 text-sm text-ink-2 hover:bg-plane"
    >
      <LayoutGrid size={16} aria-hidden />
      <span className="hidden sm:inline">アプリ一覧</span>
    </a>
  );
}
