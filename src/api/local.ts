import {
  SEED_CATEGORIES,
  buildMonthlyReport,
  type Budget,
  type Category,
  type CategoryRule,
  type MonthlyReport,
  type Receipt,
  type RecurringPayment,
  type Transaction,
  type Verdict,
} from '@kakeibo/core';
import { ApiUnavailable, type KakeiboApi, type ReceiptDraft, type SavedMapping, type Snapshot, type UploadTarget } from './types';

const KEY = 'sakekasu-kakeibo.snapshot.v1';

function emptySnapshot(): Snapshot {
  return {
    categories: SEED_CATEGORIES,
    rules: [],
    budgets: [],
    transactions: [],
    receipts: [],
    mappings: [],
    recurring: [],
  };
}

function read(): Snapshot {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return emptySnapshot();
    return { ...emptySnapshot(), ...(JSON.parse(raw) as Partial<Snapshot>) };
  } catch {
    // 壊れた保存内容で起動できなくなるほうが困るので、読めなければ初期状態から始める
    return emptySnapshot();
  }
}

function write(snapshot: Snapshot): void {
  window.localStorage.setItem(KEY, JSON.stringify(snapshot));
}

function update(mutate: (snapshot: Snapshot) => Snapshot): void {
  write(mutate(read()));
}

/**
 * AWS を使わないモード。データはこのブラウザの localStorage にだけ入る。
 * OCR と画像の置き場所だけは代わりが用意できないので、はっきり断る。
 */
export const localApi: KakeiboApi = {
  mode: 'local',

  async loadSnapshot(): Promise<Snapshot> {
    return read();
  },

  async putTransactions(transactions: Transaction[]): Promise<void> {
    update((snapshot) => {
      const byId = new Map(snapshot.transactions.map((txn) => [txn.id, txn]));
      for (const txn of transactions) byId.set(txn.id, txn);
      return { ...snapshot, transactions: [...byId.values()] };
    });
  },

  async updateTransaction(transaction: Transaction): Promise<void> {
    update((snapshot) => ({
      ...snapshot,
      transactions: snapshot.transactions.map((txn) => (txn.id === transaction.id ? transaction : txn)),
    }));
  },

  async deleteTransaction(id: string): Promise<void> {
    update((snapshot) => ({ ...snapshot, transactions: snapshot.transactions.filter((txn) => txn.id !== id) }));
  },

  async putCategories(categories: Category[]): Promise<void> {
    update((snapshot) => ({ ...snapshot, categories }));
  },

  async putRules(rules: CategoryRule[]): Promise<void> {
    update((snapshot) => ({ ...snapshot, rules }));
  },

  async putRecurring(recurring: RecurringPayment[]): Promise<void> {
    update((snapshot) => ({ ...snapshot, recurring }));
  },

  async putBudget(budget: Budget): Promise<void> {
    update((snapshot) => ({
      ...snapshot,
      budgets: [...snapshot.budgets.filter((item) => item.month !== budget.month), budget],
    }));
  },

  async putMapping(mapping: SavedMapping): Promise<void> {
    update((snapshot) => ({
      ...snapshot,
      mappings: [...snapshot.mappings.filter((item) => item.sourceId !== mapping.sourceId), mapping],
    }));
  },

  async putReceipt(receipt: Receipt): Promise<void> {
    update((snapshot) => ({
      ...snapshot,
      receipts: [...snapshot.receipts.filter((item) => item.id !== receipt.id), receipt],
    }));
  },

  async deleteReceipt(id: string): Promise<void> {
    update((snapshot) => ({ ...snapshot, receipts: snapshot.receipts.filter((item) => item.id !== id) }));
  },

  async requestUpload(): Promise<UploadTarget> {
    throw new ApiUnavailable('画像の保存には AWS 側が必要です。レシートは品目を手で入れてください。');
  },

  async analyzeReceipt(): Promise<ReceiptDraft> {
    throw new ApiUnavailable('OCR には AWS 側が必要です。レシートは品目を手で入れてください。');
  },

  /**
   * カテゴリ判定も AWS 側が要る。呼び出し側はこれを飲み込んで、
   * キーワード表とルールの答えで進む（判定が無くても家計簿は使える）。
   */
  async classify(): Promise<Record<string, Verdict>> {
    throw new ApiUnavailable('カテゴリの判定には AWS 側が必要です。');
  },

  /** ローカルモードでは月次レポートをその場で組む。Lambda の代わり */
  async getReport(month: string): Promise<MonthlyReport | undefined> {
    const snapshot = read();
    return buildMonthlyReport({
      month,
      transactions: snapshot.transactions,
      categories: snapshot.categories,
      budget: snapshot.budgets.find((budget) => budget.month === month),
    });
  },
};
