import { parseDateCell } from '../date';
import { parseAmountCell } from '../money';
import { normalizeMerchant } from '../merchant';
import { classify } from '../rules';
import { fnv1a64 } from '../hash';
import type { CategoryRule, ColumnMapping, SourceKind, Split, Transaction } from '../types';

export type ImportInput = {
  rows: string[][];
  mapping: ColumnMapping;
  source: SourceKind;
  sourceLabel: string;
  rules: CategoryRule[];
  importId?: string;
  /** 年の無い日付形式を補うための年 */
  referenceYear?: number;
};

export type SkippedRow = {
  rowIndex: number;
  reason: '日付が読めない' | '金額が読めない' | '金額が 0' | '列の指定が足りない';
  row: string[];
};

export type ImportResult = {
  transactions: Transaction[];
  skipped: SkippedRow[];
};

/**
 * 明細 ID は内容から決める。同じ CSV を 2 回落としても二重に増えないようにするため。
 * 店舗名は正規化してから混ぜる。表記が揺れただけで別の明細になってしまうのを防ぐ。
 */
export function transactionId(source: SourceKind, date: string, amount: number, rawMerchant: string): string {
  return fnv1a64([source, date, String(amount), normalizeMerchant(rawMerchant)].join('|')).slice(0, 16);
}

export function buildTransactions(input: ImportInput): ImportResult {
  const { rows, mapping, source, sourceLabel, rules, importId, referenceYear } = input;
  const transactions: Transaction[] = [];
  const skipped: SkippedRow[] = [];
  const seen = new Map<string, number>();

  if (mapping.date < 0 || mapping.amount < 0 || mapping.merchant < 0) {
    return { transactions, skipped: rows.map((row, rowIndex) => ({ rowIndex, reason: '列の指定が足りない', row })) };
  }

  const dataRows = mapping.headerRowIndex >= 0 ? rows.slice(mapping.headerRowIndex + 1) : rows;

  dataRows.forEach((row, offset) => {
    const rowIndex = offset + (mapping.headerRowIndex >= 0 ? mapping.headerRowIndex + 1 : 0);
    const date = parseDateCell(row[mapping.date] ?? '', referenceYear);
    if (!date) {
      skipped.push({ rowIndex, reason: '日付が読めない', row });
      return;
    }

    const amount = resolveAmount(row, mapping);
    if (amount === undefined) {
      skipped.push({ rowIndex, reason: '金額が読めない', row });
      return;
    }
    if (amount === 0) {
      skipped.push({ rowIndex, reason: '金額が 0', row });
      return;
    }

    const rawMerchant = (row[mapping.merchant] ?? '').trim();
    const baseId = transactionId(source, date, amount, rawMerchant);
    const occurrence = (seen.get(baseId) ?? 0) + 1;
    seen.set(baseId, occurrence);
    const id = occurrence === 1 ? baseId : `${baseId}-${occurrence}`;

    const classification = classify(rawMerchant, rules);
    const split: Split = {
      id: `${id}-1`,
      amount,
      categoryId: classification.categoryId,
      origin: classification.ruleId ? 'rule' : 'fallback',
    };

    transactions.push({
      id,
      date,
      amount,
      rawMerchant,
      merchant: normalizeMerchant(rawMerchant),
      source,
      sourceLabel,
      splits: [split],
      needsDetail: classification.ambiguous,
      ...(importId ? { importId } : {}),
    });
  });

  return { transactions, skipped };
}

function resolveAmount(row: string[], mapping: ColumnMapping): number | undefined {
  const primary = parseAmountCell(row[mapping.amount] ?? '');
  if (primary !== undefined && primary !== 0) {
    return mapping.sign === 'negative-expense' ? -primary : primary;
  }
  // 出金・入金が別列に分かれている形式。入金は返金なので支出の負として持つ
  if (mapping.refund !== undefined) {
    const refund = parseAmountCell(row[mapping.refund] ?? '');
    if (refund !== undefined && refund !== 0) return -Math.abs(refund);
  }
  return primary;
}

export type MergeResult = {
  merged: Transaction[];
  added: number;
  kept: number;
};

/**
 * 取り込み済みの明細と突き合わせる。同じ ID があれば保存済みの方を残す。
 * 内訳の分割やレシートの紐付けは手作業の結果なので、再取り込みで消さない。
 */
export function mergeImported(existing: Transaction[], incoming: Transaction[]): MergeResult {
  const byId = new Map(existing.map((txn) => [txn.id, txn]));
  let added = 0;
  let kept = 0;

  for (const txn of incoming) {
    if (byId.has(txn.id)) {
      kept += 1;
      continue;
    }
    byId.set(txn.id, txn);
    added += 1;
  }

  const merged = [...byId.values()].sort((a, b) => (a.date === b.date ? a.id.localeCompare(b.id) : b.date.localeCompare(a.date)));
  return { merged, added, kept };
}
