import type {
  Budget,
  Category,
  CategoryRule,
  ClassifyTarget,
  ColumnMapping,
  MonthlyReport,
  Receipt,
  ReceiptDraft,
  RecurringPayment,
  SourceKind,
  Transaction,
  Verdict,
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
  recurring: RecurringPayment[];
};

/** OCR が返すレシートの下書き。Lambda と同じ型を core から読む */
export type { ReceiptDraft } from '@kakeibo/core';

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
  putRecurring(recurring: RecurringPayment[]): Promise<void>;
  putBudget(budget: Budget): Promise<void>;
  putMapping(mapping: SavedMapping): Promise<void>;
  putReceipt(receipt: Receipt): Promise<void>;
  deleteReceipt(id: string): Promise<void>;
  /** レシート画像の置き場所を用意する。ローカルモードでは使えない */
  requestUpload(contentType: string): Promise<UploadTarget>;
  /**
   * レシートの写真を読む（Claude API、失敗したら Bedrock）。ローカルモードでは使えない。
   * 長いレシートを分けて撮ったときは keys に上から順に渡すと、1 枚のレシートとして読む
   */
  analyzeReceipt(input: { key?: string; keys?: string[]; dataUrl?: string }): Promise<ReceiptDraft>;
  /**
   * 品目名や店舗名のカテゴリを判定する（Jev）。ローカルモードでは使えない。
   * 返るのは投げた key ごとの結論。呼び出し側は落ちても進めること
   */
  classify(target: ClassifyTarget): Promise<Record<string, Verdict>>;
  getReport(month: string): Promise<MonthlyReport | undefined>;
}

export class ApiUnavailable extends Error {}
