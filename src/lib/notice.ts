import { useCallback, useMemo, useState } from 'react';
import { errorMessage } from './errors';

export type NoticeMessage = { tone: 'info' | 'error'; text: string };

/**
 * 画面の中に出す知らせ（操作の結果か失敗）を 1 つ持つ。描くのは components/ui/Notice。
 * 失敗を info と同じ見た目で出すと、保存できたのかどうかが文面を読むまで分からない
 */
export function useNotice() {
  const [notice, setNotice] = useState<NoticeMessage | undefined>();
  const info = useCallback((text: string) => setNotice({ tone: 'info', text }), []);
  const fail = useCallback((cause: unknown) => setNotice({ tone: 'error', text: errorMessage(cause) }), []);
  const clear = useCallback(() => setNotice(undefined), []);
  return useMemo(() => ({ notice, info, fail, clear }), [notice, info, fail, clear]);
}
