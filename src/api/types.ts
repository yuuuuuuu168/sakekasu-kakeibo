import type {
  Budget,
  Category,
  CategoryRule,
  ClassifyTarget,
  MonthlyReport,
  Receipt,
  ReceiptDraft,
  SavedMapping,
  Snapshot,
  RecurringPayment,
  Transaction,
  Verdict,
} from '@kakeibo/core';

/** 保存データの形は core（snapshot.ts）にある。月次レポートの Lambda と同じ型を見る */
export type { SavedMapping, Snapshot } from '@kakeibo/core';

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
