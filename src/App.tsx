import { Settings } from 'lucide-react';
import { AuthGate } from './features/auth/AuthGate';
import { StoreProvider, useStore } from './api/store';
import { ROUTES, SETTINGS_PATH, useRoute } from './lib/router';
import { config } from './config';
import { cn } from './lib/cn';
import { DashboardPage } from './features/dashboard/DashboardPage';
import { ImportPage } from './features/import/ImportPage';
import { TransactionsPage } from './features/transactions/TransactionsPage';
import { ReceiptsPage } from './features/receipts/ReceiptsPage';
import { ReportPage } from './features/report/ReportPage';
import { SettingsPage } from './features/settings/SettingsPage';
import { SignOutButton } from './features/auth/SignOutButton';
import { AppsLink } from './features/auth/AppsLink';
import { ActionErrorProvider } from './components/ActionErrorProvider';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Notice } from './components/ui/Notice';
import { useActionError } from './lib/action';

export function App() {
  return (
    <AuthGate>
      {(signOutFn) => (
        <StoreProvider>
          <ActionErrorProvider>
            <Shell onSignOut={signOutFn} />
          </ActionErrorProvider>
        </StoreProvider>
      )}
    </AuthGate>
  );
}

function Shell({ onSignOut }: { onSignOut: () => Promise<void> }) {
  const route = useRoute();
  const { loading, error } = useStore();
  const actionError = useActionError();

  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-40 border-b border-grid bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-2">
          <span className="text-sm font-semibold text-ink">sakekasu 家計簿</span>
          {config.mode === 'local' && (
            <span className="rounded-md bg-warning/20 px-1.5 py-0.5 text-xs text-ink">ローカルモード</span>
          )}
          <div className="flex-1" />
          <AppsLink />
          <a
            href={SETTINGS_PATH}
            aria-label="設定"
            aria-current={route.name === 'settings' ? 'page' : undefined}
            className={cn(
              'rounded-md p-1.5 hover:bg-plane',
              route.name === 'settings' ? 'bg-accent/12 text-accent' : 'text-ink-2',
            )}
          >
            <Settings size={16} />
          </a>
          {config.mode === 'remote' && <SignOutButton onSignOut={onSignOut} />}
        </div>
        <nav className="mx-auto max-w-5xl overflow-x-auto px-2 pb-1">
          <ul className="flex gap-1">
            {ROUTES.map((item) => (
              <li key={item.name}>
                <a
                  href={item.path}
                  className={cn(
                    'block whitespace-nowrap rounded-lg px-3 py-1.5 text-sm',
                    route.name === item.name ? 'bg-accent/12 font-medium text-accent' : 'text-ink-2 hover:bg-plane',
                  )}
                >
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        {/* 保存の失敗は、どこまで下に送っていても見えるよう、上に貼り付いた帯の中に出す */}
        {actionError && (
          <div className="mx-auto max-w-5xl px-4 pb-2">
            <Notice tone="error" onDismiss={actionError.dismiss}>
              保存できませんでした。{actionError.message}
            </Notice>
          </div>
        )}
      </header>

      <main className="mx-auto max-w-5xl px-4 py-4">
        {error && (
          <Notice tone="error" className="mb-3">
            データの読み込みに失敗しました。{error}
          </Notice>
        )}
        {loading ? (
          <p className="py-8 text-center text-sm text-ink-2">読み込み中…</p>
        ) : (
          <ErrorBoundary key={route.name}>
            <Page />
          </ErrorBoundary>
        )}
      </main>
    </div>
  );
}

function Page() {
  const route = useRoute();
  switch (route.name) {
    case 'import':
      return <ImportPage />;
    case 'transactions':
      return <TransactionsPage month={route.month} filter={route.filter} />;
    case 'dashboard':
      return <DashboardPage />;
    case 'report':
      return <ReportPage month={route.month} />;
    case 'settings':
      return <SettingsPage />;
    default:
      return <ReceiptsPage />;
  }
}
