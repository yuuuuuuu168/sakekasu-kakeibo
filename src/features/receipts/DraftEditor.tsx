import { Plus, Trash2 } from 'lucide-react';
import { CURRENCIES, CURRENCY_LABELS, UNCATEGORIZED_ID, formatMoney, type Category, type Currency } from '@kakeibo/core';
import { CategoryOptions } from '../../components/CategoryOptions';
import { MoneyInput } from '../../components/ui/MoneyInput';
import { Button, Field, Input, Select } from '../../components/ui/primitives';
import { lacksRate, removeItem, updateItem, withCurrency, yenHint, type Draft } from './draft';

/**
 * 下書きの中身を直す欄。読み取りの注意書き、店名・日付・通貨・合計、ドルのレート、品目の一覧。
 * 保存のしかた（明細に当てる・登録する・直した内容で保存）は呼び出し側が下に並べる
 */
export function DraftEditor({
  draft,
  onChange,
  categories,
  fallbackRate,
}: {
  draft: Draft;
  onChange: (draft: Draft) => void;
  /** 選べるカテゴリ（消したものは除いてある） */
  categories: Category[];
  /** ドルに切り替えたときに入れる、直近のドルのレシートのレート */
  fallbackRate: number | undefined;
}) {
  const itemsTotal = draft.items.reduce((sum, item) => sum + item.amount, 0);
  const money = (amount: number) => formatMoney(amount, draft.currency);
  const hint = yenHint(draft);

  return (
    <>
      {draft.warnings && draft.warnings.length > 0 && (
        <ul className="mb-3 space-y-1 rounded-lg bg-warning/12 px-3 py-2 text-xs text-ink">
          {draft.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="店名">
          <Input value={draft.storeName} onChange={(event) => onChange({ ...draft, storeName: event.target.value })} />
        </Field>
        <Field label="日付">
          <Input type="date" value={draft.date} onChange={(event) => onChange({ ...draft, date: event.target.value })} />
        </Field>
        {/* 1 つの label に 2 つの入力を入れると、ラベルを押したときに通貨の側へ行ってしまう */}
        <div className="flex gap-1.5">
          <div className="w-[4.5rem] shrink-0">
            <Field label="通貨">
              <Select
                value={draft.currency}
                onChange={(event) => onChange(withCurrency(draft, event.target.value as Currency, fallbackRate))}
                className="w-full"
              >
                {CURRENCIES.map((currency) => (
                  <option key={currency} value={currency}>
                    {CURRENCY_LABELS[currency]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="min-w-0 flex-1">
            <Field label="合計" hint={itemsTotal !== draft.total ? `品目の合計は ${money(itemsTotal)}` : hint}>
              <MoneyInput amount={draft.total} currency={draft.currency} onChange={(total) => onChange({ ...draft, total })} className="w-full" />
            </Field>
          </div>
        </div>
      </div>

      {draft.currency !== 'JPY' && (
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <Field
            label="1 ドルの円"
            hint={
              lacksRate(draft)
                ? 'レートを入れてください'
                : itemsTotal !== draft.total
                  ? hint
                  : '明細に当てると、請求額から実際のレートに置き換えます'
            }
          >
            <Input
              type="number"
              inputMode="decimal"
              step="0.01"
              value={draft.exchangeRate ?? ''}
              onChange={(event) => {
                const rate = Number(event.target.value);
                onChange({ ...draft, exchangeRate: event.target.value === '' || !Number.isFinite(rate) ? undefined : rate });
              }}
              className="tnum text-right"
            />
          </Field>
        </div>
      )}

      <h3 className="mt-4 text-xs font-semibold text-ink-2">品目</h3>
      <ul className="mt-1 space-y-2">
        {draft.items.map((item, index) => (
          // 目印に品目名を混ぜると、1 文字打つたびに行が作り直されて入力欄から外れる
          <li key={index} className="flex items-center gap-1.5">
            {/* 左からカテゴリ・品名・金額。幅は品名に回し、カテゴリは選べる分だけに絞る */}
            <Select
              value={item.categoryId ?? UNCATEGORIZED_ID}
              onChange={(event) => onChange(updateItem(draft, index, { categoryId: event.target.value, categoryEdited: true }))}
              className="w-[5.5rem] min-w-0 shrink-0"
              aria-label="カテゴリ"
            >
              <CategoryOptions categories={categories} />
            </Select>
            <Input
              value={item.name}
              onChange={(event) => onChange(updateItem(draft, index, { name: event.target.value }))}
              placeholder="品目名"
              className="min-w-0 flex-1"
              aria-label="品目名"
            />
            <MoneyInput
              amount={item.amount}
              currency={draft.currency}
              onChange={(amount) => onChange(updateItem(draft, index, { amount }))}
              className="w-[4.5rem] shrink-0"
              aria-label="金額"
            />
            <button
              type="button"
              onClick={() => onChange(removeItem(draft, index))}
              className="shrink-0 rounded-md p-1 text-ink-2 hover:bg-plane"
              aria-label="この品目を消す"
            >
              <Trash2 size={15} />
            </button>
          </li>
        ))}
      </ul>
      <Button
        size="sm"
        className="mt-2"
        onClick={() => onChange({ ...draft, items: [...draft.items, { name: '', amount: 0, categoryId: UNCATEGORIZED_ID }] })}
      >
        <Plus size={14} />
        品目を足す
      </Button>
    </>
  );
}
