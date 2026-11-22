import {
  type Budget,
  type Category,
  type CategoryRule,
  type MailRelayFilter,
  type Receipt,
  type RecurringPayment,
  type SavedMapping,
  type Snapshot,
  type Transaction,
} from '@kakeibo/core';

/**
 * 利用者のパーティション（`USER#{sub}`、shared/user-partition.ts）の中の並び。
 * 明細・レシート・上限・列の対応は 1 件 1 行、カテゴリ・ルール・定期支払いは 1 行にまとめて持つ。
 */
export const SK = {
  transaction: (id: string) => `TXN#${id}`,
  categories: 'CONFIG#categories',
  rules: 'CONFIG#rules',
  recurring: 'CONFIG#recurring',
  /** Yahoo!メールの中継が Muse へ転送するメールの条件。中継の Lambda もこの行を読む */
  mailRelayFilter: 'CONFIG#mailRelayFilter',
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
    else if (sk === SK.mailRelayFilter) snapshot.mailRelayFilter = mailRelayFilterOf(item.mailRelayFilter);
    else if (sk.startsWith('BUDGET#')) snapshot.budgets.push(strip(item) as unknown as Budget);
    else if (sk.startsWith('RECEIPT#')) snapshot.receipts.push(strip(item) as unknown as Receipt);
    else if (sk.startsWith('MAPPING#')) snapshot.mappings.push(strip(item) as unknown as SavedMapping);
  }

  return snapshot;
}

/** 保存した条件を読む。形が崩れていたら空（全部を転送）にする */
export function mailRelayFilterOf(value: unknown): MailRelayFilter {
  const filter = (value ?? {}) as Partial<Record<keyof MailRelayFilter, unknown>>;
  const strings = (list: unknown) => asArray(list).filter((entry): entry is string => typeof entry === 'string');
  return { senders: strings(filter.senders), subjectWords: strings(filter.subjectWords) };
}

/** キーは保存のための列なので、画面には返さない */
function strip(item: Item): Item {
  const { pk: _pk, sk: _sk, ...rest } = item;
  return rest;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
