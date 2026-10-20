import { SEED_CATEGORIES, withLaterSeeds } from './categories';
import type { ReportInput } from './report';
import type { Budget, Category, CategoryRule, ColumnMapping, Receipt, RecurringPayment, SourceKind, Transaction } from './types';

/*
 * 1 人分の保存データ全部。画面は起動時にこれを丸ごと読み、月次レポートの Lambda も同じ形で読む。
 *
 * 保存のしかた（localStorage か DynamoDB か）は呼び出し側が持ち、ここには「読んだものを
 * どう補うか」と「保存したものをどう差し込むか」だけを置く。補い方を画面・ローカルモード・
 * Lambda で別々に書くと、同じ月のレポートが場所によって違う中身になる。
 */

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

export function emptySnapshot(): Snapshot {
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

/**
 * 読んだ保存データの欠けを補う。
 *
 * カテゴリが 1 つも無ければ初期カテゴリから始める（使い始め）。あれば、使い始めた後で
 * 初期カテゴリに足したもの（値引き）を補う。初期カテゴリは一覧が空のときにしか入らないので、
 * こうしないと後から足したカテゴリが出てこない。
 */
export function normalizeSnapshot(loaded: Partial<Snapshot>): Snapshot {
  const categories = loaded.categories?.length ? withLaterSeeds(loaded.categories) : SEED_CATEGORIES;
  return { ...emptySnapshot(), ...loaded, categories };
}

/** その月のレポートの材料。画面（ローカルモード）と月次レポートの Lambda で同じものを渡す */
export function reportInputFor(snapshot: Snapshot, month: string): ReportInput {
  return {
    month,
    transactions: snapshot.transactions,
    categories: snapshot.categories,
    budget: snapshot.budgets.find((budget) => budget.month === month),
    receipts: snapshot.receipts,
    recurring: snapshot.recurring,
  };
}

/*
 * 保存したものを手元のデータに差し込む。画面の store（保存が済んでから画面を変える）と
 * ローカルモード（localStorage を書き換える）が同じ規則で差し込むように、ここにまとめる。
 */

/** 明細は id で上書きし、無ければ足す。取り込みの重複は id で弾いてある */
export function upsertTransactions(snapshot: Snapshot, transactions: Transaction[]): Snapshot {
  const byId = new Map(snapshot.transactions.map((txn) => [txn.id, txn]));
  for (const txn of transactions) byId.set(txn.id, txn);
  return { ...snapshot, transactions: [...byId.values()] };
}

/** 既にある明細だけを差し替える。無い id は足さない（足すのは upsertTransactions） */
export function replaceTransaction(snapshot: Snapshot, transaction: Transaction): Snapshot {
  return { ...snapshot, transactions: snapshot.transactions.map((txn) => (txn.id === transaction.id ? transaction : txn)) };
}

export function removeTransactionFrom(snapshot: Snapshot, id: string): Snapshot {
  return { ...snapshot, transactions: snapshot.transactions.filter((txn) => txn.id !== id) };
}

/** 上限は月ごとに 1 つ */
export function upsertBudget(snapshot: Snapshot, budget: Budget): Snapshot {
  return { ...snapshot, budgets: [...snapshot.budgets.filter((item) => item.month !== budget.month), budget] };
}

/** 列の対応は取り込み元ごとに 1 つ */
export function upsertMapping(snapshot: Snapshot, mapping: SavedMapping): Snapshot {
  return { ...snapshot, mappings: [...snapshot.mappings.filter((item) => item.sourceId !== mapping.sourceId), mapping] };
}

export function upsertReceipt(snapshot: Snapshot, receipt: Receipt): Snapshot {
  return { ...snapshot, receipts: [...snapshot.receipts.filter((item) => item.id !== receipt.id), receipt] };
}

export function removeReceiptFrom(snapshot: Snapshot, id: string): Snapshot {
  return { ...snapshot, receipts: snapshot.receipts.filter((item) => item.id !== id) };
}
