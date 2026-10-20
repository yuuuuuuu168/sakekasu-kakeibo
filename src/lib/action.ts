import { createContext, useCallback, useContext } from 'react';

/**
 * ボタンや入力から投げっぱなしで呼ぶ保存の、失敗の受け口。
 *
 * 画面の操作は `onClick={() => void save()}` の形で呼ぶことが多く、そのままだと API の
 * 失敗が画面のどこにも出ない（保存できていないのに気づけない）。`useAction()` の run で
 * 包むと、失敗したときに画面上部の帯に理由を出す。帯は components/ActionErrorProvider が持つ。
 *
 * Provider の外（部品だけを描くテスト）では、帯の代わりにコンソールへ出す。
 */
export type ActionError = { message: string; dismiss: () => void } | undefined;

export type ActionContextValue = {
  error: ActionError;
  report: (cause: unknown) => void;
};

export const ActionContext = createContext<ActionContextValue | undefined>(undefined);

/** 失敗を帯に出す run を返す。run は例外を投げないので、`void run(...)` のまま呼んでよい */
export function useAction(): (action: () => Promise<unknown>) => Promise<void> {
  const report = useContext(ActionContext)?.report ?? reportToConsole;
  return useCallback(
    async (action: () => Promise<unknown>) => {
      try {
        await action();
      } catch (cause) {
        report(cause);
      }
    },
    [report],
  );
}

/** 帯に出している失敗。Provider の外では常に undefined */
export function useActionError(): ActionError {
  return useContext(ActionContext)?.error;
}

function reportToConsole(cause: unknown) {
  console.error(cause);
}
