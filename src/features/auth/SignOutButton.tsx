import { LogOut } from 'lucide-react';

/**
 * ヘッダ右上、歯車の隣に置くサインアウト。sakekasu-builder・sakekasu-learning と同じく、
 * どの画面からでも右上で 1 回押せばよい。設定画面の一番下に置いていたころは、
 * カテゴリと定期支払いを越えてスクロールしないと届かなかった。
 * 狭い画面ではアイコンだけにし、文字は sm 以上で出す（learning と同じ）。
 */
export function SignOutButton({ onSignOut }: { onSignOut: () => Promise<void> }) {
  return (
    <button
      type="button"
      aria-label="サインアウト"
      title="サインアウト"
      onClick={() => void onSignOut()}
      className="flex items-center gap-1 rounded-md p-1.5 text-sm text-ink-2 hover:bg-plane"
    >
      <LogOut size={16} aria-hidden />
      <span className="hidden sm:inline">サインアウト</span>
    </button>
  );
}
