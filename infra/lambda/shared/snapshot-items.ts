import type { Budget, Category, CategoryRule, Receipt, RecurringPayment, SavedMapping, Snapshot, Transaction } from '@kakeibo/core';

/**
 * 利用者のパーティション（`USER#{sub}`、shared/user-partition.ts）の中の並び。
 * 明細・レシート・上限・列の対応は 1 件 1 行、カテゴリ・ルール・定期支払いは 1 行にまとめて持つ。
 */
export const SK = {
  transaction: (id: string) => `TXN#${id}`,
  categories: 'CONFIG#categories',
  rules: 'CONFIG#rules',
  recurring: 'CONFIG#recurring',
  budget: (month: string) => `BUDGET#${month}`,
  mapping: (sourceId: string) => `MAPPING#${sourceId}`,
  receipt: (id: string) => `RECEIPT#${id}`,
  report: (month: string) => `REPORT#${month}`,
};

type Item = Record<string, unknown>;

/**
 * パーティションの行を保存データの形に組む。api の GET /snapshot と月次レポートの Lambda が使う。
 *
 * ここでは補わない（カテゴリの行が無ければ空のまま）。欠けの補い方は core の normalizeSnapshot に
 * 1 つだけ置き、画面と月次レポートの両方がそれを通す。レポートの行（REPORT#）は保存データではないので拾わない。
 */
export function snapshotFromItems(items: Item[]): Snapshot {
  const snapshot: Snapshot = {
    categories: [],
    rules: [],
    budgets: [],
    transactions: [],
    receipts: [],
    mappings: [],
    recurring: [],
  };

  for (const item of items) {
    const sk = String(item.sk);
    if (sk.startsWith('TXN#')) snapshot.transactions.push(strip(item) as unknown as Transaction);
    else if (sk === SK.categories) snapshot.categories = asArray(item.categories) as Category[];
    else if (sk === SK.rules) snapshot.rules = asArray(item.rules) as CategoryRule[];
    else if (sk === SK.recurring) snapshot.recurring = asArray(item.recurring) as RecurringPayment[];
    else if (sk.startsWith('BUDGET#')) snapshot.budgets.push(strip(item) as unknown as Budget);
    else if (sk.startsWith('RECEIPT#')) snapshot.receipts.push(strip(item) as unknown as Receipt);
    else if (sk.startsWith('MAPPING#')) snapshot.mappings.push(strip(item) as unknown as SavedMapping);
  }

  return snapshot;
}

/** キーは保存のための列なので、画面には返さない */
function strip(item: Item): Item {
  const { pk: _pk, sk: _sk, ...rest } = item;
  return rest;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
