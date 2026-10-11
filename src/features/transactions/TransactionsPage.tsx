import { useMemo, useState } from 'react';
import { ArrowLeftRight, Copy, Scissors, Tag, Trash2 } from 'lucide-react';
import {
  TRANSFER_ID,
  UNCATEGORIZED_ID,
  activeCategories,
  allRules,
  asTransfer,
  categoryLabel,
  duplicateKey,
  findDuplicates,
  findMisfiledTransfers,
  formatMoney,
  formatYen,
  isTransfer,
  learnRule,
  markNotDuplicate,
  rootCategoryId,
  monthOf,
  refileDiscounts,
  shouldLearnRule,
  transactionsOfMonth,
  type Category,
  type DuplicatePair,
  type Receipt,
  type Transaction,
} from '@kakeibo/core';
import { CategoryOptions } from '../../components/CategoryOptions';
import { useStore } from '../../api/store';
import { Badge, Button, Card, EmptyState, Select } from '../../components/ui/primitives';
import { MonthPicker } from '../../components/ui/MonthPicker';
import { SplitDialog } from './SplitDialog';
import { currentMonth } from '../../lib/month';
import { DUPLICATES_FILTER, NEEDS_DETAIL_FILTER } from '../../lib/router';

export function TransactionsPage({ month: initialMonth, filter: initialFilter }: { month?: string; filter?: string }) {
  const { snapshot, rules, saveTransaction, saveTransactions, saveReceipt, removeTransaction, saveRules } = useStore();
  const [month, setMonth] = useState(initialMonth ?? currentMonth());
  const [filter, setFilter] = useState(initialFilter ?? 'all');
  const [editing, setEditing] = useState<Transaction | undefined>();

  const categories = activeCategories(snapshot.categories);

  /**
   * ルールは取り込みのときにしか当たらない。チャージのルールを足す前に取り込んだ分は
   * 交通費などに入ったままなので、振替の絞り込みを開いたときに名指しして直せるようにする。
   */
  const misfiled = useMemo(() => {
    if (filter !== TRANSFER_ID) return [];
    return findMisfiledTransfers(transactionsOfMonth(snapshot.transactions, month), rules);
  }, [snapshot.transactions, month, filter, rules]);

  /**
   * 値引きのカテゴリを足す前に保存した明細とレシート。月をまたいで全件から探す。
   * 一度付け替えれば出てこなくなるので、絞り込みに関係なく帯を出す
   */
  const discounts = useMemo(
    () => refileDiscounts(snapshot.transactions, snapshot.receipts),
    [snapshot.transactions, snapshot.receipts],
  );
  const [refiling, setRefiling] = useState(false);

  const rows = useMemo(() => {
    const monthly = transactionsOfMonth(snapshot.transactions, month).sort((a, b) => b.date.localeCompare(a.date));
    if (filter === 'all') return monthly;
    if (filter === NEEDS_DETAIL_FILTER) return monthly.filter((txn) => txn.needsDetail);
    // 振替では、まだ振替になっていないチャージの候補も一緒に出す。帯の件数と一覧を合わせるため
    if (filter === TRANSFER_ID) {
      const suspects = new Set(misfiled.map((txn) => txn.id));
      return monthly.filter((txn) => isTransfer(txn) || suspects.has(txn.id));
    }
    // 大カテゴリで絞ったときは、その下の小カテゴリの明細も出す
    return monthly.filter((txn) =>
      txn.splits.some((split) => split.categoryId === filter || rootCategoryId(snapshot.categories, split.categoryId) === filter),
    );
  }, [snapshot.transactions, snapshot.categories, month, filter, misfiled]);

  /**
   * 重複は月をまたぐ。月末に現金で保存したレシートと、翌月頭に計上されたカード明細が典型。
   * そこで探すのは全件からにして、どちらかがこの月に入る組だけを出す。
   */
  const duplicates = useMemo(() => {
    if (filter !== DUPLICATES_FILTER) return [];
    return findDuplicates(snapshot.transactions).filter(
      (pair) => monthOf(pair.a.date) === month || monthOf(pair.b.date) === month,
    );
  }, [snapshot.transactions, month, filter]);

  const total = rows.reduce((sum, txn) => sum + txn.amount, 0);

  /**
   * カテゴリを直したら、同じ店は今後も同じカテゴリになるようルールを増やす。
   * コンビニや Amazon のような混ざる店は、その 1 回だけの例外として直すので覚えない
   */
  async function recategorize(txn: Transaction, categoryId: string) {
    const updated: Transaction = {
      ...txn,
      splits: [{ id: `${txn.id}-1`, amount: txn.amount, categoryId, origin: 'manual' }],
      needsDetail: false,
    };
    await saveTransaction(updated);

    if (!shouldLearnRule(txn.rawMerchant, allRules(snapshot.rules))) return;
    const rule = learnRule(txn.rawMerchant, categoryId);
    const others = snapshot.rules.filter((item) => item.id !== rule.id);
    await saveRules([...others, rule]);
  }

  /** チャージらしいのに別のカテゴリのままの明細を、まとめて振替にする */
  async function markAllAsTransfer() {
    for (const txn of misfiled) await saveTransaction(asTransfer(txn));
  }

  /** 値引きの行を値引きのカテゴリへ移す。レシートの品目も揃えておかないと、レシートを当て直したときに戻る */
  async function refileAllDiscounts() {
    setRefiling(true);
    try {
      for (const receipt of discounts.receipts) await saveReceipt(receipt);
      if (discounts.transactions.length > 0) await saveTransactions(discounts.transactions);
    } finally {
      setRefiling(false);
    }
  }

  /** 重複ではないと言われた組。両側に印を付けて、次からは候補に出さない */
  async function dismissDuplicate(pair: DuplicatePair) {
    const [a, b] = markNotDuplicate(pair.a, pair.b);
    await saveTransaction(a);
    await saveTransaction(b);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-ink">明細</h1>
        <div className="flex items-center gap-2">
          <Select value={filter} onChange={(event) => setFilter(event.target.value)}>
            <option value="all">すべて</option>
            <option value={NEEDS_DETAIL_FILTER}>内訳待ちだけ</option>
            <option value={DUPLICATES_FILTER}>重複の可能性だけ</option>
            <option value={UNCATEGORIZED_ID}>未分類だけ</option>
            <CategoryOptions categories={categories} exclude={[UNCATEGORIZED_ID]} />
          </Select>
          <MonthPicker month={month} onChange={setMonth} />
        </div>
      </div>

      {misfiled.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-warning/12 px-4 py-3 ring-1 ring-warning/30">
          <ArrowLeftRight size={18} aria-hidden className="text-ink" />
          <p className="flex-1 text-sm text-ink">
            チャージらしい明細が {misfiled.length} 件、まだ支出として計上されています。振替にすると、この分がカテゴリ別の実績から外れます。
          </p>
          <Button variant="primary" size="sm" onClick={() => void markAllAsTransfer()}>
            まとめて振替にする
          </Button>
        </div>
      )}

      {(discounts.transactions.length > 0 || discounts.receipts.length > 0) && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-warning/12 px-4 py-3 ring-1 ring-warning/30">
          <Tag size={18} aria-hidden className="text-ink" />
          <p className="flex-1 text-sm text-ink">
            値引きのカテゴリを作る前に入れた値引きが、明細 {discounts.transactions.length} 件・レシート {discounts.receipts.length} 枚に残っています
            （全期間）。付け替えると、品目は値引き前の額になり、値引きは「値引き」の行に出ます。
          </p>
          <Button variant="primary" size="sm" onClick={() => void refileAllDiscounts()} disabled={refiling}>
            値引きに付け替える
          </Button>
        </div>
      )}

      {filter === DUPLICATES_FILTER ? (
        <DuplicatesCard
          pairs={duplicates}
          categories={snapshot.categories}
          receipts={snapshot.receipts}
          onRemove={removeTransaction}
          onDismiss={dismissDuplicate}
        />
      ) : (
        <Card title={`${rows.length} 件`} action={<span className="tnum text-sm font-semibold text-ink">{formatYen(total)}</span>}>
          {rows.length === 0 ? (
            <EmptyState title="該当する明細がありません">
              <a href="#/import" className="text-accent">
                明細を取り込む
              </a>
            </EmptyState>
          ) : (
            <ul className="divide-y divide-grid">
              {rows.map((txn) => (
                <li key={txn.id} className="py-3">
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="tnum text-xs text-muted">{txn.date.slice(5)}</span>
                        <span className="truncate text-sm font-medium text-ink">{txn.rawMerchant || '（店名なし）'}</span>
                        <span className="text-xs text-muted">{txn.sourceLabel}</span>
                        {txn.needsDetail && <Badge tone="accent">内訳待ち</Badge>}
                        {txn.receiptId && <Badge tone="good">レシートあり</Badge>}
                        {isTransfer(txn) && <Badge tone="neutral">振替・集計外</Badge>}
                        {misfiled.some((item) => item.id === txn.id) && <Badge tone="warning">チャージらしい</Badge>}
                      </div>

                      {txn.splits.length > 1 ? (
                        <ul className="mt-1.5 space-y-0.5">
                          {txn.splits.map((split) => (
                            <li key={split.id} className="flex items-baseline gap-2 text-xs">
                              <span className="text-ink-2">{categoryLabel(snapshot.categories, split.categoryId)}</span>
                              {split.name && <span className="truncate text-muted">{split.name}</span>}
                              <span className="flex-1 border-b border-dotted border-grid" />
                              <span className="tnum text-ink-2">{formatYen(split.amount)}</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <div className="mt-1.5">
                          <Select
                            value={txn.splits[0]?.categoryId ?? UNCATEGORIZED_ID}
                            onChange={(event) => void recategorize(txn, event.target.value)}
                            className="text-xs"
                            aria-label="カテゴリ"
                          >
                            <CategoryOptions categories={categories} />
                          </Select>
                        </div>
                      )}
                    </div>

                    <div className="flex shrink-0 flex-col items-end gap-1.5">
                      <span className="tnum text-sm font-semibold text-ink">{formatYen(txn.amount)}</span>
                      {txn.foreign && (
                        <span className="tnum -mt-1 text-xs text-muted">{formatMoney(txn.foreign.amount, txn.foreign.currency)}</span>
                      )}
                      <div className="flex gap-1">
                        <button
                          type="button"
                          onClick={() => setEditing(txn)}
                          className="rounded-md p-1.5 text-ink-2 hover:bg-plane"
                          aria-label="内訳を分ける"
                          title="内訳を分ける"
                        >
                          <Scissors size={15} />
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (window.confirm('この明細を消しますか')) void removeTransaction(txn.id);
                          }}
                          className="rounded-md p-1.5 text-ink-2 hover:bg-plane"
                          aria-label="消す"
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {editing && (
        <SplitDialog
          transaction={editing}
          categories={snapshot.categories}
          onClose={() => setEditing(undefined)}
          onSave={saveTransaction}
        />
      )}
    </div>
  );
}

/**
 * 重複候補は 1 件ずつではなく組で見せる。どちらを消すかを決めるには両方の日付と
 * 取り込み元が要るので、明細一覧の行の形では足りない。
 * 金額は一致しているのが前提なので、見比べる材料は内訳・レシート・メモのほうにある。
 * 店名だけでは同じ買い物か判断できないことがあるため、それらも並べて出す。
 */
function DuplicatesCard({
  pairs,
  categories,
  receipts,
  onRemove,
  onDismiss,
}: {
  pairs: DuplicatePair[];
  categories: Category[];
  receipts: Receipt[];
  onRemove: (id: string) => Promise<void>;
  onDismiss: (pair: DuplicatePair) => Promise<void>;
}) {
  const receiptById = useMemo(() => new Map(receipts.map((receipt) => [receipt.id, receipt])), [receipts]);

  return (
    <Card title={`重複の可能性 ${pairs.length} 組`}>
      {pairs.length === 0 ? (
        <EmptyState title="重複の可能性はありません">
          金額が一致して日付が 4 日以内の明細どうしを見ています。「重複ではない」と印を付けた組は出ません
        </EmptyState>
      ) : (
        <ul className="divide-y divide-grid">
          {pairs.map((pair) => (
            <li key={duplicateKey(pair)} className="py-3">
              <div className="flex items-center gap-1.5">
                <Copy size={14} className="text-muted" aria-hidden />
                <span className="text-xs text-muted">{pair.reasons.join('・')}</span>
              </div>

              <ul className="mt-2 grid gap-2 md:grid-cols-2">
                {[pair.a, pair.b].map((txn) => (
                  <li key={txn.id} className="rounded-lg bg-plane px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className="tnum text-xs text-muted">{txn.date.slice(5)}</span>
                      <span className="min-w-0 flex-1 truncate text-sm text-ink">{txn.rawMerchant || '（店名なし）'}</span>
                      <span className="tnum text-sm font-semibold text-ink">{formatYen(txn.amount)}</span>
                      <button
                        type="button"
                        onClick={() => {
                          if (window.confirm('この明細を消しますか。内訳も一緒に消えます')) void onRemove(txn.id);
                        }}
                        className="rounded-md p-1.5 text-ink-2 hover:bg-surface"
                        aria-label={`${txn.date} の ${txn.rawMerchant || '店名なし'}（${txn.sourceLabel}）を消す`}
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                    <DuplicateDetail
                      txn={txn}
                      categories={categories}
                      receipt={txn.receiptId ? receiptById.get(txn.receiptId) : undefined}
                    />
                  </li>
                ))}
              </ul>

              <div className="mt-2 flex justify-end">
                <Button size="sm" onClick={() => void onDismiss(pair)}>
                  重複ではない
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** 長いレシートで組が縦に伸びすぎないよう、内訳はここまで出して残りは開いたときだけ */
const DETAIL_LINES = 5;

/** 重複候補の片側の詳細。取り込み元、内訳、紐付いたレシート、メモを出す */
function DuplicateDetail({ txn, categories, receipt }: { txn: Transaction; categories: Category[]; receipt?: Receipt }) {
  const [expanded, setExpanded] = useState(false);
  const splits = expanded ? txn.splits : txn.splits.slice(0, DETAIL_LINES);
  const hidden = txn.splits.length - splits.length;

  return (
    <div className="mt-1.5 space-y-1.5 border-t border-grid pt-1.5 text-xs">
      <div className="flex flex-wrap items-center gap-1.5 text-muted">
        <span className="tnum">{formatDateWithWeekday(txn.date)}</span>
        <span>・{txn.sourceLabel}</span>
        {txn.merchant && txn.merchant !== txn.rawMerchant && <span className="truncate">・{txn.merchant}</span>}
        {txn.foreign && <span className="tnum">・{formatMoney(txn.foreign.amount, txn.foreign.currency)}</span>}
        {txn.needsDetail && <Badge tone="accent">内訳待ち</Badge>}
        {isTransfer(txn) && <Badge tone="neutral">振替・集計外</Badge>}
      </div>

      {receipt ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone="good">レシートあり</Badge>
          <span className="truncate text-ink-2">{receipt.storeName || '（店名なし）'}</span>
          <span className="tnum text-muted">{formatDateWithWeekday(receipt.date)}</span>
          <span className="text-muted">{receipt.items.length} 品</span>
        </div>
      ) : (
        txn.receiptId && <Badge tone="good">レシートあり</Badge>
      )}

      <ul className="space-y-0.5" aria-label={`${txn.rawMerchant || '店名なし'}（${txn.sourceLabel}）の内訳`}>
        {splits.map((split) => (
          <li key={split.id} className="flex items-baseline gap-2">
            <span className="shrink-0 text-ink-2">{categoryLabel(categories, split.categoryId)}</span>
            {split.name && <span className="truncate text-muted">{split.name}</span>}
            <span className="flex-1 border-b border-dotted border-grid" />
            <span className="tnum text-ink-2">{formatYen(split.amount)}</span>
          </li>
        ))}
      </ul>
      {txn.splits.length > DETAIL_LINES && (
        <button type="button" onClick={() => setExpanded(!expanded)} className="text-accent">
          {expanded ? '閉じる' : `ほか ${hidden} 行を見る`}
        </button>
      )}

      {txn.note && <p className="whitespace-pre-wrap text-ink-2">メモ: {txn.note}</p>}
    </div>
  );
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

/** 2026-10-10 → 2026/10/10（土）。曜日があると「平日の昼か週末か」で見分けが付くことがある */
function formatDateWithWeekday(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return date;
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${y}/${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}（${weekday}）`;
}
