import { describe, expect, it } from 'vitest';
import { formatYen, parseAmountCell, ratio } from '../money';

describe('parseAmountCell', () => {
  it.each([
    ['1,200', 1200],
    ['¥1,200', 1200],
    ['1200円', 1200],
    ['-1,200', -1200],
    ['(1,200)', -1200],
    ['△1,200', -1200],
    ['▲980', -980],
    ['１，２００', 1200],
    ['0', 0],
  ])('%s を %i にする', (input, expected) => {
    expect(parseAmountCell(input)).toBe(expected);
  });

  it('金額でないセルは undefined', () => {
    expect(parseAmountCell('')).toBeUndefined();
    expect(parseAmountCell('ご利用金額')).toBeUndefined();
  });

  it('小数は四捨五入して整数にする', () => {
    expect(parseAmountCell('1200.4')).toBe(1200);
    expect(parseAmountCell('1200.6')).toBe(1201);
  });
});

describe('formatYen', () => {
  it('桁区切りと符号を付ける', () => {
    expect(formatYen(1200)).toBe('¥1,200');
    expect(formatYen(-1200)).toBe('-¥1,200');
    expect(formatYen(0)).toBe('¥0');
  });
});

describe('ratio', () => {
  it('上限 0 で実績があれば Infinity', () => {
    expect(ratio(100, 0)).toBe(Number.POSITIVE_INFINITY);
    expect(ratio(0, 0)).toBe(0);
    expect(ratio(50, 100)).toBe(0.5);
  });
});
