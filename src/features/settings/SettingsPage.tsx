import { CategoriesPage } from '../categories/CategoriesPage';
import { LearnedRules } from '../rules/LearnedRules';
import { RecurringPayments } from '../recurring/RecurringPayments';

/**
 * 設定。タブからは外して、ヘッダの歯車から開く。
 * 中身は既存の画面をそのまま並べているだけで、カテゴリと上限の操作は CategoriesPage が、
 * 定期的な支払いは RecurringPayments が、覚えたカテゴリ（品目・店名のルール）は LearnedRules が持つ。
 * サインアウトはヘッダの右上（SignOutButton）にある。
 */
export function SettingsPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold text-ink">設定</h1>

      <CategoriesPage />

      <RecurringPayments />

      <LearnedRules />
    </div>
  );
}
