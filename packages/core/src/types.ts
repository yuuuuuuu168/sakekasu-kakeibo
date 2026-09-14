/** 明細の出どころ。CSV の列マッピングを保存する単位でもある */
export type SourceKind = 'credit' | 'paypay' | 'cash' | 'manual';

export type Category = {
  id: string;
  label: string;
  order: number;
  /** 統合や整理で使わなくなったカテゴリ。集計からは外すが過去データは残す */
  archived?: boolean;
};

/** 内訳 1 行。amount の合計は必ず親の明細の amount に一致する */
export type Split = {
  id: string;
  /** 品目名。レシート由来のときだけ入る */
  name?: string;
  amount: number;
  categoryId: string;
  origin: SplitOrigin;
};

export type SplitOrigin = 'rule' | 'receipt' | 'manual' | 'fallback';

export type Transaction = {
  id: string;
  /** 利用日。YYYY-MM-DD */
  date: string;
  /** 円の整数。支出は正、返金は負 */
  amount: number;
  /** 明細に書かれていた店舗名そのまま */
  rawMerchant: string;
  /** 正規化した店舗名。ルールの照合と表示に使う */
  merchant: string;
  source: SourceKind;
  /** 「楽天カード」「PayPay」など、取り込み元の表示名 */
  sourceLabel: string;
  splits: Split[];
  /** 内訳が複数カテゴリに割れる可能性があり、まだ確定していない */
  needsDetail: boolean;
  receiptId?: string;
  importId?: string;
  note?: string;
  /**
   * 「重複ではない」と人が言った相手の明細 ID。印は両側に持たせる。
   * 消すだけだと取り込み直しで戻ってくるので、否定したことのほうを覚えておく。
   */
  notDuplicateOf?: string[];
};

export type MatchType = 'contains' | 'equals' | 'startsWith' | 'regex';

export type CategoryRule = {
  id: string;
  /** 照合する文字列。regex 以外は照合時に正規化される */
  pattern: string;
  matchType: MatchType;
  categoryId: string;
  /** 1 回の支払いに複数カテゴリが混ざる店。当たると needsDetail が立つ */
  ambiguous?: boolean;
  /** 大きいほど優先。同値なら pattern の長い方が勝つ */
  priority: number;
  builtin?: boolean;
};

export type ReceiptItem = {
  name: string;
  amount: number;
  /** OCR が推定したカテゴリ ID。外していれば画面で直す */
  categoryId?: string;
  quantity?: number;
};

export type Receipt = {
  id: string;
  /** レシートに印字されていた店舗名 */
  storeName: string;
  /** YYYY-MM-DD */
  date: string;
  total: number;
  items: ReceiptItem[];
  imageKey?: string;
  /** 紐付いた明細の ID */
  txnId?: string;
  status: 'pending' | 'matched' | 'cash' | 'discarded';
  createdAt?: string;
};

export type Budget = {
  /** YYYY-MM */
  month: string;
  /** カテゴリ ID → 月の上限額（円） */
  limits: Record<string, number>;
};

/** CSV の列とその意味の対応 */
export type ColumnMapping = {
  /** ヘッダ行の位置。ヘッダが無ければ -1 */
  headerRowIndex: number;
  date: number;
  amount: number;
  merchant: number;
  /** 入金・返金が別列に入る形式（PayPay 等）で使う */
  refund?: number;
  /** 金額列の符号の意味。negative-expense は「支出がマイナス」 */
  sign: 'positive-expense' | 'negative-expense';
};
