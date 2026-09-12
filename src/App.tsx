import { LogOut } from 'lucide-react';
import { AuthGate } from './features/auth/AuthGate';
import { StoreProvider, useStore } from './api/store';
import { ROUTES, useRoute } from './lib/router';
import { config } from './config';
import { cn } from './lib/cn';
import { DashboardPage } from './features/dashboard/DashboardPage';
import { ImportPage } from './features/import/ImportPage';
import { TransactionsPage } from './features/transactions/TransactionsPage';
import { ReceiptsPage } from './features/receipts/ReceiptsPage';
import { CategoriesPage } from './features/categories/CategoriesPage';
import { ReportPage } from './features/report/ReportPage';

export function App() {
  return (
    <AuthGate>
      {(signOutFn) => (
        <StoreProvider>
          <Shell onSignOut={signOutFn} />
        </StoreProvider>
      )}
    </AuthGate>
  );
}

function Shell({ onSignOut }: { onSignOut: () => Promise<void> }) {
  const route = useRoute();
  const { loading, error } = useStore();

  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-40 border-b border-grid bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-2">
          <span className="text-sm font-semibold text-ink">sakekasu 家計簿</span>
          {config.mode === 'local' && (
            <span className="rounded-md bg-warning/20 px-1.5 py-0.5 text-xs text-ink">ローカルモード</span>
          )}
          <div className="flex-1" />
          {config.mode === 'remote' && (
            <button type="button" onClick={() => void onSignOut()} className="rounded-md p-1.5 text-ink-2 hover:bg-plane" aria-label="サインアウト">
              <LogOut size={16} />
            </button>
          )}
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
      </header>

      <main className="mx-auto max-w-5xl px-4 py-4">
        {error && (
          <p className="mb-3 rounded-lg bg-critical/12 px-3 py-2 text-sm text-critical">
            データの読み込みに失敗しました。{error}
          </p>
        )}
        {loading ? <p className="py-8 text-center text-sm text-ink-2">読み込み中…</p> : <Page />}
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
    case 'receipts':
      return <ReceiptsPage />;
    case 'categories':
      return <CategoriesPage />;
    case 'report':
      return <ReportPage month={route.month} />;
    default:
      return <DashboardPage />;
  }
}
