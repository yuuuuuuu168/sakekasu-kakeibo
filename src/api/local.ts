import {
  buildMonthlyReport,
  emptySnapshot,
  normalizeSnapshot,
  removeReceiptFrom,
  removeTransactionFrom,
  replaceTransaction,
  reportInputFor,
  upsertBudget,
  upsertMapping,
  upsertReceipt,
  upsertTransactions,
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
    update((snapshot) => upsertTransactions(snapshot, transactions));
  },

  async updateTransaction(transaction: Transaction): Promise<void> {
    update((snapshot) => replaceTransaction(snapshot, transaction));
  },

  async deleteTransaction(id: string): Promise<void> {
    update((snapshot) => removeTransactionFrom(snapshot, id));
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
    update((snapshot) => upsertBudget(snapshot, budget));
  },

  async putMapping(mapping: SavedMapping): Promise<void> {
    update((snapshot) => upsertMapping(snapshot, mapping));
  },

  async putReceipt(receipt: Receipt): Promise<void> {
    update((snapshot) => upsertReceipt(snapshot, receipt));
  },

  async deleteReceipt(id: string): Promise<void> {
    update((snapshot) => removeReceiptFrom(snapshot, id));
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

  /**
   * ローカルモードでは月次レポートをその場で組む。Lambda の代わり。
   * 補い方と材料は Lambda と同じ（normalizeSnapshot / reportInputFor）
   */
  async getReport(month: string): Promise<MonthlyReport | undefined> {
    return buildMonthlyReport(reportInputFor(normalizeSnapshot(read()), month));
  },
};
