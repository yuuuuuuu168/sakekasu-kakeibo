import { fromMinor, toMinor, type Currency } from '@kakeibo/core';
import { Input } from './primitives';

/**
 * 金額の入力欄。保存は最小単位の整数（円、セント）で、見せるのはその通貨の数（12.34 ドル）。
 * ドルは小数を打てるように step と inputMode を変える。
 */
export function MoneyInput({
  amount,
  currency,
  onChange,
  className,
  ...rest
}: {
  amount: number;
  currency: Currency;
  onChange: (amount: number) => void;
  className?: string;
  'aria-label'?: string;
}) {
  const decimal = currency !== 'JPY';
  return (
    <Input
      type="number"
      inputMode={decimal ? 'decimal' : 'numeric'}
      step={decimal ? '0.01' : '1'}
      value={fromMinor(amount, currency)}
      onChange={(event) => onChange(toMinor(Number(event.target.value) || 0, currency))}
      className={`tnum text-right ${className ?? ''}`}
      {...rest}
    />
  );
}
