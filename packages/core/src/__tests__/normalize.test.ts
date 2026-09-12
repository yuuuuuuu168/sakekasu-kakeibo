import { describe, expect, it } from 'vitest';
import { buildTransactions, mergeImported, transactionId } from '../statement/normalize';
import { detectColumns } from '../statement/columns';
import { parseCsv } from '../statement/csv';
import { BUILTIN_RULES } from '../rules';
import type { Transaction } from '../types';

const CSV = [
  '利用日,利用店名・商品名,利用金額',
  '2026/09/01,セブン－イレブン品川,1200',
  '2026/09/03,AMAZON.CO.JP*M12AB3CD4,3480',
  '2026/09/05,スターバックス 品川,620',
  '2026/09/06,,0',
  '合計,,5300',
].join('\n');

function importCsv(text = CSV) {
  const rows = parseCsv(text);
  return buildTransactions({
    rows,
    mapping: detectColumns(rows),
    source: 'credit',
    sourceLabel: '楽天カード',
    rules: BUILTIN_RULES,
    importId: 'imp-1',
  });
}

describe('buildTransactions', () => {
  it('明細を作り、読めない行は理由付きで落とす', () => {
    const { transactions, skipped } = importCsv();
    expect(transactions).toHaveLength(3);
    expect(skipped.map((row) => row.reason)).toEqual(['金額が 0', '日付が読めない']);
  });

  it('内訳は 1 行から始まり、合計が明細の金額に一致する', () => {
    const { transactions } = importCsv();
    for (const txn of transactions) {
      expect(txn.splits.reduce((sum, split) => sum + split.amount, 0)).toBe(txn.amount);
    }
  });

  it('コンビニと Amazon は内訳待ち、カフェは確定', () => {
    const { transactions } = importCsv();
    const byMerchant = Object.fromEntries(transactions.map((txn) => [txn.splits[0].categoryId, txn.needsDetail]));
    expect(byMerchant.food).toBe(true);
    expect(byMerchant.daily).toBe(true);
    expect(byMerchant.cafe).toBe(false);
  });

  it('同じ CSV を 2 回取り込んでも ID が変わらない', () => {
    const first = importCsv().transactions.map((txn) => txn.id);
    const second = importCsv().transactions.map((txn) => txn.id);
    expect(second).toEqual(first);
  });

  it('店名の表記が揺れても同じ ID になる', () => {
    const a = transactionId('credit', '2026-09-01', 1200, 'セブン－イレブン品川 1234');
    const b = transactionId('credit', '2026-09-01', 1200, 'ｾﾌﾞﾝ-ｲﾚﾌﾞﾝ品川');
    expect(a).toBe(b);
  });

  it('同じ日に同じ店で同じ金額を 2 回使っても両方残る', () => {
    const text = ['利用日,利用店名,利用金額', '2026/09/01,自販機,150', '2026/09/01,自販機,150'].join('\n');
    const { transactions } = importCsv(text);
    expect(transactions).toHaveLength(2);
    expect(new Set(transactions.map((txn) => txn.id)).size).toBe(2);
  });

  it('列の指定が足りなければ全行を落とす', () => {
    const rows = parseCsv('a,b\n1,2');
    const result = buildTransactions({
      rows,
      mapping: { headerRowIndex: -1, date: -1, amount: -1, merchant: -1, sign: 'positive-expense' },
      source: 'credit',
      sourceLabel: 'テスト',
      rules: BUILTIN_RULES,
    });
    expect(result.transactions).toHaveLength(0);
    expect(result.skipped[0].reason).toBe('列の指定が足りない');
  });

  it('入金列は返金として負の金額で入る', () => {
    const text = ['取引日,出金金額,入金金額,取引先', '2026/09/05,,1200,ローソン品川'].join('\n');
    const rows = parseCsv(text);
    const { transactions } = buildTransactions({
      rows,
      mapping: detectColumns(rows),
      source: 'paypay',
      sourceLabel: 'PayPay',
      rules: BUILTIN_RULES,
    });
    expect(transactions[0].amount).toBe(-1200);
  });
});

describe('mergeImported', () => {
  const existing: Transaction[] = [
    {
      id: 'a',
      date: '2026-09-01',
      amount: 1200,
      rawMerchant: 'セブン',
      merchant: 'セブン',
      source: 'credit',
      sourceLabel: '楽天カード',
      splits: [
        { id: 's1', name: 'おにぎり', amount: 800, categoryId: 'food', origin: 'receipt' },
        { id: 's2', name: 'ティッシュ', amount: 400, categoryId: 'daily', origin: 'receipt' },
      ],
      needsDetail: false,
      receiptId: 'r1',
    },
  ];

  it('再取り込みで手作業の内訳を消さない', () => {
    const incoming: Transaction[] = [
      { ...existing[0], splits: [{ id: 's1', amount: 1200, categoryId: 'food', origin: 'rule' }], needsDetail: true, receiptId: undefined },
    ];
    const result = mergeImported(existing, incoming);
    expect(result.added).toBe(0);
    expect(result.kept).toBe(1);
    expect(result.merged[0].splits).toHaveLength(2);
    expect(result.merged[0].receiptId).toBe('r1');
  });

  it('新しい明細は足され、日付の新しい順に並ぶ', () => {
    const incoming: Transaction[] = [{ ...existing[0], id: 'b', date: '2026-09-05' }];
    const result = mergeImported(existing, incoming);
    expect(result.added).toBe(1);
    expect(result.merged.map((txn) => txn.date)).toEqual(['2026-09-05', '2026-09-01']);
  });
});
