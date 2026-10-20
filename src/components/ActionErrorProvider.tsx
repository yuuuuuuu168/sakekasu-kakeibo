import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { ActionContext, type ActionContextValue } from '../lib/action';
import { errorMessage } from '../lib/errors';

/** useAction の run が拾った失敗を持つ。帯は App の Shell が useActionError で出す */
export function ActionErrorProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<string | undefined>();
  const report = useCallback((cause: unknown) => {
    console.error(cause);
    setMessage(errorMessage(cause) || '原因が分かりませんでした');
  }, []);
  const value = useMemo<ActionContextValue>(
    () => ({ error: message === undefined ? undefined : { message, dismiss: () => setMessage(undefined) }, report }),
    [message, report],
  );
  return <ActionContext.Provider value={value}>{children}</ActionContext.Provider>;
}
