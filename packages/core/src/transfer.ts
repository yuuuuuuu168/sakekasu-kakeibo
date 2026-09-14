import { TRANSFER_ID } from './categories';
import { classify } from './rules';
import type { CategoryRule, Transaction } from './types';

/**
 * 残高へのチャージの扱い。PayPay へのチャージも、JRE カードからの Suica チャージも、
 * カードの明細には支払いとして出るが、金は自分の残高へ移っただけで、まだ何にも使っていない。
 * 支出として数えるのは残高側の利用明細のほうで、チャージを一緒に数えると二重計上になる。
 *
 * 重複検知（duplicate.ts）では拾えない。チャージ 1 件に対して利用は何件にも割れ、金額も日付も
 * 揃わないからで、これは組を探す話ではなく、集計から外す話になる。
 */

/** 内訳が全部チャージなら、その明細は振替。集計には入れない */
export function isTransfer(txn: Transaction): boolean {
  return txn.splits.length > 0 && txn.splits.every((split) => split.categoryId === TRANSFER_ID);
}

/**
 * 内訳にチャージが 1 行でも混じっているか。
 * 1 件の明細をチャージと買い物に割ることはできるので、全部がチャージとは限らない。
 * 額を数えるとき（transferTotal）はこの粒度で見るので、件数もこれに合わせる。
 */
export function hasTransfer(txn: Transaction): boolean {
  return txn.splits.some((split) => split.categoryId === TRANSFER_ID);
}

/**
 * 支出として数える額。チャージの内訳を引いた残り。
 * 明細まるごとを落とすだけだと、割った明細のチャージ分が残って二重計上になる。
 * 集計・前月との比較・「よく使った店」は、どれもこの額で数える。
 */
export function spendingAmount(txn: Transaction): number {
  return txn.splits.reduce((sum, split) => (split.categoryId === TRANSFER_ID ? sum : sum + split.amount), 0);
}

/** 振替を落とした明細。カテゴリ別の実績はこれを見る */
export function spendingOnly(transactions: Transaction[]): Transaction[] {
  return transactions.filter((txn) => !isTransfer(txn));
}

/** 振替に入っている額の合計。支出ではないが、カードからは出ているので画面には出す */
export function transferTotal(transactions: Transaction[]): number {
  let total = 0;
  for (const txn of transactions) {
    for (const split of txn.splits) {
      if (split.categoryId === TRANSFER_ID) total += split.amount;
    }
  }
  return total;
}

/**
 * 今のルールならチャージと判定されるのに、別のカテゴリのまま残っている明細。
 * ルールは取り込みのときにしか当たらないので、チャージのルールを足す前に取り込んだ分が
 * ここに出る。交通費として計上されたままの Suica チャージがこれに当たる。
 */
export function findMisfiledTransfers(transactions: Transaction[], rules: CategoryRule[]): Transaction[] {
  return transactions.filter(
    (txn) => !isTransfer(txn) && classify(txn.rawMerchant, rules).categoryId === TRANSFER_ID,
  );
}

/** 明細まるごとを振替にする。内訳は 1 行にまとめる（何を買ったかの情報は元から無い） */
export function asTransfer(txn: Transaction): Transaction {
  return {
    ...txn,
    splits: [{ id: `${txn.id}-1`, amount: txn.amount, categoryId: TRANSFER_ID, origin: 'manual' }],
    needsDetail: false,
  };
}
