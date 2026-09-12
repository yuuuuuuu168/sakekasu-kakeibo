import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  SEED_CATEGORIES,
  allRules,
  type Budget,
  type Category,
  type CategoryRule,
  type Receipt,
  type Transaction,
} from '@kakeibo/core';
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
  saveBudget: (budget: Budget) => Promise<void>;
  saveMapping: (mapping: SavedMapping) => Promise<void>;
  saveReceipt: (receipt: Receipt) => Promise<void>;
  removeReceipt: (id: string) => Promise<void>;
};

const EMPTY: Snapshot = {
  categories: SEED_CATEGORIES,
  rules: [],
  budgets: [],
  transactions: [],
  receipts: [],
  mappings: [],
};

const StoreContext = createContext<Store | undefined>(undefined);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const loaded = await api.loadSnapshot();
      setSnapshot({ ...EMPTY, ...loaded, categories: loaded.categories?.length ? loaded.categories : SEED_CATEGORIES });
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
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
          (current) => {
            const byId = new Map(current.transactions.map((txn) => [txn.id, txn]));
            for (const txn of transactions) byId.set(txn.id, txn);
            return { ...current, transactions: [...byId.values()] };
          },
        ),
      saveTransaction: (transaction) =>
        commit(
          () => api.updateTransaction(transaction),
          (current) => ({
            ...current,
            transactions: current.transactions.map((txn) => (txn.id === transaction.id ? transaction : txn)),
          }),
        ),
      removeTransaction: (id) =>
        commit(
          () => api.deleteTransaction(id),
          (current) => ({ ...current, transactions: current.transactions.filter((txn) => txn.id !== id) }),
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
      saveBudget: (budget) =>
        commit(
          () => api.putBudget(budget),
          (current) => ({ ...current, budgets: [...current.budgets.filter((item) => item.month !== budget.month), budget] }),
        ),
      saveMapping: (mapping) =>
        commit(
          () => api.putMapping(mapping),
          (current) => ({
            ...current,
            mappings: [...current.mappings.filter((item) => item.sourceId !== mapping.sourceId), mapping],
          }),
        ),
      saveReceipt: (receipt) =>
        commit(
          () => api.putReceipt(receipt),
          (current) => ({ ...current, receipts: [...current.receipts.filter((item) => item.id !== receipt.id), receipt] }),
        ),
      removeReceipt: (id) =>
        commit(
          () => api.deleteReceipt(id),
          (current) => ({ ...current, receipts: current.receipts.filter((item) => item.id !== id) }),
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
