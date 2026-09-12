import { looksLikeDate } from '../date';
import { parseAmountCell } from '../money';
import type { ColumnMapping } from '../types';

/**
 * ヘッダ名の候補。先に書いたものを優先する。
 * カードの CSV には金額の列が複数ある（利用金額、支払総額、手数料、今回請求額）。
 * 欲しいのは 1 回の買い物の金額なので「ご利用金額」を最優先にする。
 */
const DATE_HEADERS = ['ご利用日', '利用日', 'ご利用年月日', '利用年月日', '取引日', '決済日', '日付', '取引日時', '支払日', 'date'];
const AMOUNT_HEADERS = ['ご利用金額', '利用金額', '取引金額', '出金金額', '支払金額', '決済金額', '請求金額', 'ご請求額', '金額', '出金', 'amount'];
// PayPay の CSV は「取引内容」に「支払い」、「取引先」に店名が入る。店名の列を先に見る
const MERCHANT_HEADERS = ['ご利用先', 'ご利用店名', '利用店名', 'ご利用場所', '利用先', '取引先', '支払先', '店名', 'ご利用内容', '取引内容', '内容', '摘要', 'description', 'merchant'];
const REFUND_HEADERS = ['入金金額', '入金'];

function normalizeHeader(cell: string): string {
  return cell.normalize('NFKC').replace(/\s/g, '').toLowerCase();
}

function headerScore(cell: string, candidates: string[]): number {
  const header = normalizeHeader(cell);
  if (header === '') return 0;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = normalizeHeader(candidates[index]);
    if (header === candidate) return 1000 - index;
    if (header.includes(candidate)) return 500 - index;
  }
  return 0;
}

function bestColumn(headerRow: string[], candidates: string[]): number {
  let best = -1;
  let bestScore = 0;
  headerRow.forEach((cell, index) => {
    const score = headerScore(cell, candidates);
    if (score > bestScore) {
      bestScore = score;
      best = index;
    }
  });
  return best;
}

/** ヘッダ行を探す。日付と金額らしい列名が同じ行に揃っていればそこ */
function findHeaderRow(rows: string[][]): number {
  const limit = Math.min(rows.length, 12);
  for (let index = 0; index < limit; index += 1) {
    const row = rows[index];
    const hasDate = bestColumn(row, DATE_HEADERS) >= 0;
    const hasAmount = bestColumn(row, AMOUNT_HEADERS) >= 0;
    if (hasDate && hasAmount) return index;
  }
  return -1;
}

/** ヘッダが無い CSV 向け。値の形から日付・金額・店名の列を当てる */
function detectByValues(rows: string[][]): { date: number; amount: number; merchant: number } {
  const width = Math.max(...rows.map((row) => row.length), 0);
  const sample = rows.slice(0, 40);

  let date = -1;
  let dateHits = 0;
  for (let column = 0; column < width; column += 1) {
    const hits = sample.filter((row) => looksLikeDate(row[column] ?? '')).length;
    if (hits > dateHits) {
      dateHits = hits;
      date = column;
    }
  }

  let amount = -1;
  let amountScore = 0;
  for (let column = 0; column < width; column += 1) {
    if (column === date) continue;
    const values = sample
      .map((row) => parseAmountCell(row[column] ?? ''))
      .filter((value): value is number => value !== undefined);
    if (values.length === 0) continue;
    const average = values.reduce((sum, value) => sum + Math.abs(value), 0) / values.length;
    // 分割回数やポイント数のような小さい整数の列を金額と誤認しないよう、桁の大きさも見る
    const score = values.length * Math.min(average, 100_000);
    if (score > amountScore) {
      amountScore = score;
      amount = column;
    }
  }

  let merchant = -1;
  let merchantScore = 0;
  for (let column = 0; column < width; column += 1) {
    if (column === date || column === amount) continue;
    const lengths = sample.map((row) => (row[column] ?? '').replace(/\s/g, '').length);
    const nonNumeric = sample.filter((row) => {
      const cell = row[column] ?? '';
      return cell !== '' && parseAmountCell(cell) === undefined;
    }).length;
    const average = lengths.reduce((sum, value) => sum + value, 0) / Math.max(sample.length, 1);
    const score = nonNumeric * average;
    if (score > merchantScore) {
      merchantScore = score;
      merchant = column;
    }
  }

  return { date, amount, merchant };
}

/** 金額列の符号の向きを決める。支出がマイナスで入る形式（入出金明細）がある */
function detectSign(rows: string[][], amountColumn: number): ColumnMapping['sign'] {
  if (amountColumn < 0) return 'positive-expense';
  const values = rows
    .map((row) => parseAmountCell(row[amountColumn] ?? ''))
    .filter((value): value is number => value !== undefined && value !== 0);
  if (values.length === 0) return 'positive-expense';
  const negatives = values.filter((value) => value < 0).length;
  return negatives > values.length / 2 ? 'negative-expense' : 'positive-expense';
}

/**
 * CSV の列の意味を推定する。外したら画面で指定し直せる前提の、当たれば嬉しい程度の処理。
 * 推定できなかった列は -1 を返す。
 */
export function detectColumns(rows: string[][]): ColumnMapping {
  if (rows.length === 0) {
    return { headerRowIndex: -1, date: -1, amount: -1, merchant: -1, sign: 'positive-expense' };
  }

  const headerRowIndex = findHeaderRow(rows);
  const dataRows = headerRowIndex >= 0 ? rows.slice(headerRowIndex + 1) : rows;

  if (headerRowIndex >= 0) {
    const headerRow = rows[headerRowIndex];
    const date = bestColumn(headerRow, DATE_HEADERS);
    const amount = bestColumn(headerRow, AMOUNT_HEADERS);
    const merchant = bestColumn(headerRow, MERCHANT_HEADERS);
    const refund = bestColumn(headerRow, REFUND_HEADERS);
    const fallback = detectByValues(dataRows);
    const resolved = {
      headerRowIndex,
      date: date >= 0 ? date : fallback.date,
      amount: amount >= 0 ? amount : fallback.amount,
      merchant: merchant >= 0 ? merchant : fallback.merchant,
      sign: 'positive-expense' as const,
    };
    return {
      ...resolved,
      ...(refund >= 0 && refund !== resolved.amount ? { refund } : {}),
      sign: detectSign(dataRows, resolved.amount),
    };
  }

  const detected = detectByValues(dataRows);
  return {
    headerRowIndex: -1,
    ...detected,
    sign: detectSign(dataRows, detected.amount),
  };
}

export function isMappingComplete(mapping: ColumnMapping): boolean {
  return mapping.date >= 0 && mapping.amount >= 0 && mapping.merchant >= 0;
}
