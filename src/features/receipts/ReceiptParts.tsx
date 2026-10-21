import { RECEIPT_PAYMENT_METHODS, SOURCE_LABELS, type Receipt, type SourceKind } from '@kakeibo/core';
import { Badge, Field, Select } from '../../components/ui/primitives';

/** レシートの状態の印。保存済み一覧と、同じレシートかもしれない組で同じものを出す */
export function ReceiptStatusBadge({ receipt }: { receipt: Receipt }) {
  if (receipt.status === 'matched') return <Badge tone="good">明細に紐付き</Badge>;
  if (receipt.status === 'cash') return <Badge tone="neutral">{SOURCE_LABELS[receipt.paidWith ?? 'cash']}</Badge>;
  return <Badge tone="warning">未紐付け</Badge>;
}

/**
 * 支払い方法の欄。明細を作るとき（新しく登録するときと、レシートから作った明細を直すとき）に出す。
 * 明細を取り込める支払い方法なら、二重に数えないための注意を `importableHint` で添える
 */
export function PaymentMethodField({
  value,
  onChange,
  importableHint,
}: {
  value: SourceKind;
  onChange: (method: SourceKind) => void;
  /** 選んだ支払い方法が明細を取り込めるときだけ出す一文。取り込めなければ undefined */
  importableHint: string | undefined;
}) {
  return (
    <Field label="支払い方法" hint={importableHint}>
      <Select value={value} onChange={(event) => onChange(event.target.value as SourceKind)} className="w-full">
        {RECEIPT_PAYMENT_METHODS.map((method) => (
          <option key={method} value={method}>
            {SOURCE_LABELS[method]}
          </option>
        ))}
      </Select>
    </Field>
  );
}
