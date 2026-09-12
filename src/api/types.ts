import type {
  Budget,
  Category,
  CategoryRule,
  ColumnMapping,
  MonthlyReport,
  Receipt,
  ReceiptItem,
  SourceKind,
  Transaction,
} from '@kakeibo/core';

/** CSV の列の対応をソースごとに覚えておく。2 回目以降は指定し直さなくて済む */
export type SavedMapping = {
  sourceId: string;
  label: string;
  source: SourceKind;
  mapping: ColumnMapping;
};

export type Snapshot = {
  categories: Category[];
  rules: CategoryRule[];
  budgets: Budget[];
  transactions: Transaction[];
  receipts: Receipt[];
  mappings: SavedMapping[];
};

/** OCR が返すレシートの下書き。確定前なので id は持たない */
export type ReceiptDraft = {
  storeName: string;
  date: string;
  total: number;
  items: ReceiptItem[];
  /** OCR が読み切れなかった項目の説明。画面に出して直させる */
  warnings?: string[];
};

export type UploadTarget = {
  uploadUrl: string;
  key: string;
};

export interface KakeiboApi {
  readonly mode: 'local' | 'remote';
  loadSnapshot(): Promise<Snapshot>;
  putTransactions(transactions: Transaction[]): Promise<void>;
  updateTransaction(transaction: Transaction): Promise<void>;
  deleteTransaction(id: string): Promise<void>;
  putCategories(categories: Category[]): Promise<void>;
  putRules(rules: CategoryRule[]): Promise<void>;
  putBudget(budget: Budget): Promise<void>;
  putMapping(mapping: SavedMapping): Promise<void>;
  putReceipt(receipt: Receipt): Promise<void>;
  deleteReceipt(id: string): Promise<void>;
  /** レシート画像の置き場所を用意する。ローカルモードでは使えない */
  requestUpload(contentType: string): Promise<UploadTarget>;
  /** Bedrock で画像を読む。ローカルモードでは使えない */
  analyzeReceipt(input: { key?: string; dataUrl?: string }): Promise<ReceiptDraft>;
  getReport(month: string): Promise<MonthlyReport | undefined>;
}

export class ApiUnavailable extends Error {}
