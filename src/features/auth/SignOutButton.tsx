import { LogOut } from 'lucide-react';
import { useState } from 'react';
import { Dialog } from '../../components/ui/Dialog';
import { Button } from '../../components/ui/primitives';

/**
 * ヘッダ右上、歯車の隣に置くサインアウト。多くの Web アプリと同じく、どの画面からでも 1 か所で押せる。
 * 設定画面の一番下に置いていたころは、カテゴリと定期支払いを越えてスクロールしないと届かなかった。
 * 歯車と並ぶので押し間違えやすく、押したら一度だけ確かめる。
 */
export function SignOutButton({ onSignOut }: { onSignOut: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <>
      <button
        type="button"
        aria-label="サインアウト"
        title="サインアウト"
        onClick={() => setConfirming(true)}
        className="rounded-md p-1.5 text-ink-2 hover:bg-plane"
      >
        <LogOut size={16} />
      </button>
      {confirming && (
        <Dialog title="サインアウト" onClose={() => setConfirming(false)}>
          <p className="text-sm text-ink">サインアウトしますか？</p>
          <div className="mt-4 flex justify-end gap-2">
            <Button onClick={() => setConfirming(false)}>やめる</Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void onSignOut().finally(() => setBusy(false));
              }}
            >
              <LogOut size={16} aria-hidden />
              サインアウト
            </Button>
          </div>
        </Dialog>
      )}
    </>
  );
}
