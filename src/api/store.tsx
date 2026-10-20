import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  allRules,
  emptySnapshot,
  normalizeSnapshot,
  removeReceiptFrom,
  removeTransactionFrom,
  replaceTransaction,
  upsertBudget,
  upsertMapping,
  upsertReceipt,
  upsertTransactions,
  type Budget,
  type Category,
  type CategoryRule,
  type Receipt,
  type RecurringPayment,
  type Transaction,
} from '@kakeibo/core';
import { errorMessage } from '../lib/errors';
import { api } from './index';
import type { SavedMapping, Snapshot } from './types';

type Store = {
  snapshot: Snapshot;
  loading: boolean;
  error?: string;
  /** 利用者のルールと初期搭載ルールを 1 本にしたもの。分類はいつもこれを使う */
  rules: CategoryRule[];
  reload: () => Promise<void>;
  saveTransactions: (transactions: Transaction[]) => Promise<void>;
  saveTransaction: (transaction: Transaction) => Promise<void>;
  removeTransaction: (id: string) => Promise<void>;
  saveCategories: (categories: Category[]) => Promise<void>;
  saveRules: (rules: CategoryRule[]) => Promise<void>;
  saveRecurring: (recurring: RecurringPayment[]) => Promise<void>;
  saveBudget: (budget: Budget) => Promise<void>;
  saveMapping: (mapping: SavedMapping) => Promise<void>;
  saveReceipt: (receipt: Receipt) => Promise<void>;
  removeReceipt: (id: string) => Promise<void>;
};

const StoreContext = createContext<Store | undefined>(undefined);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const loaded = await api.loadSnapshot();
      // 欠けの補い方（使い始めの初期カテゴリ、後から足した値引き）は core の normalizeSnapshot
      setSnapshot(normalizeSnapshot(loaded));
      setError(undefined);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** 保存してから画面の状態を更新する。保存に失敗したら画面も変えない */
  const commit = useCallback(async (persist: () => Promise<void>, apply: (current: Snapshot) => Snapshot) => {
    await persist();
    setSnapshot((current) => apply(current));
  }, []);

  const value = useMemo<Store>(
    () => ({
      snapshot,
      loading,
      error,
      rules: allRules(snapshot.rules),
      reload,
      saveTransactions: (transactions) =>
        commit(
          () => api.putTransactions(transactions),
          (current) => upsertTransactions(current, transactions),
        ),
      saveTransaction: (transaction) =>
        commit(
          () => api.updateTransaction(transaction),
          (current) => replaceTransaction(current, transaction),
        ),
      removeTransaction: (id) =>
        commit(
          () => api.deleteTransaction(id),
          (current) => removeTransactionFrom(current, id),
        ),
      saveCategories: (categories) =>
        commit(
          () => api.putCategories(categories),
          (current) => ({ ...current, categories }),
        ),
      saveRules: (rules) =>
        commit(
          () => api.putRules(rules),
          (current) => ({ ...current, rules }),
        ),
      saveRecurring: (recurring) =>
        commit(
          () => api.putRecurring(recurring),
          (current) => ({ ...current, recurring }),
        ),
      saveBudget: (budget) =>
        commit(
          () => api.putBudget(budget),
          (current) => upsertBudget(current, budget),
        ),
      saveMapping: (mapping) =>
        commit(
          () => api.putMapping(mapping),
          (current) => upsertMapping(current, mapping),
        ),
      saveReceipt: (receipt) =>
        commit(
          () => api.putReceipt(receipt),
          (current) => upsertReceipt(current, receipt),
        ),
      removeReceipt: (id) =>
        commit(
          () => api.deleteReceipt(id),
          (current) => removeReceiptFrom(current, id),
        ),
    }),
    [snapshot, loading, error, reload, commit],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error('StoreProvider の中で使ってください');
  return store;
}
