import { LogOut } from 'lucide-react';
import { Button, Card } from '../../components/ui/primitives';
import { config } from '../../config';
import { CategoriesPage } from '../categories/CategoriesPage';
import { RecurringPayments } from '../recurring/RecurringPayments';

/**
 * 設定。タブからは外して、ヘッダの歯車から開く。
 * 中身は既存の画面をそのまま並べているだけで、カテゴリと上限の操作は CategoriesPage が、
 * 定期的な支払いは RecurringPayments が持つ。
 */
export function SettingsPage({ onSignOut }: { onSignOut: () => Promise<void> }) {
  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold text-ink">設定</h1>

      <CategoriesPage />

      <RecurringPayments />

      {config.mode === 'remote' && (
        <Card title="アカウント">
          <Button onClick={() => void onSignOut()}>
            <LogOut size={16} aria-hidden />
            サインアウト
          </Button>
        </Card>
      )}
    </div>
  );
}
