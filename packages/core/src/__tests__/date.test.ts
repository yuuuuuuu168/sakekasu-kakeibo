import { describe, expect, it } from 'vitest';
import { daysInMonth, diffDays, elapsedDays, parseDateCell, previousMonth } from '../date';

describe('parseDateCell', () => {
  it.each([
    ['2026/09/12', '2026-09-12'],
    ['2026-9-2', '2026-09-02'],
    ['2026年9月2日', '2026-09-02'],
    ['2026.09.12', '2026-09-12'],
    ['20260912', '2026-09-12'],
    ['2026/09/12 13:45', '2026-09-12'],
  ])('%s を %s にする', (input, expected) => {
    expect(parseDateCell(input)).toBe(expected);
  });

  it('年の無い形式は referenceYear を補う', () => {
    expect(parseDateCell('9/12', 2025)).toBe('2025-09-12');
  });

  it('存在しない日付は受け取らない', () => {
    expect(parseDateCell('2026/02/30')).toBeUndefined();
    expect(parseDateCell('2026/13/01')).toBeUndefined();
  });

  it('日付でないセルは undefined', () => {
    expect(parseDateCell('ご利用日')).toBeUndefined();
    expect(parseDateCell('')).toBeUndefined();
  });
});

describe('日付の計算', () => {
  it('日数の差を返す', () => {
    expect(diffDays('2026-09-12', '2026-09-10')).toBe(2);
    expect(diffDays('2026-09-01', '2026-08-31')).toBe(1);
    expect(diffDays('2026-09-10', '2026-09-12')).toBe(-2);
  });

  it('月の日数と前月', () => {
    expect(daysInMonth('2026-02')).toBe(28);
    expect(daysInMonth('2024-02')).toBe(29);
    expect(daysInMonth('2026-09')).toBe(30);
    expect(previousMonth('2026-01')).toBe('2025-12');
    expect(previousMonth('2026-09')).toBe('2026-08');
  });

  it('経過日数は当月なら今日、過去の月なら月末', () => {
    expect(elapsedDays('2026-09', '2026-09-12')).toBe(12);
    expect(elapsedDays('2026-08', '2026-09-12')).toBe(31);
    expect(elapsedDays('2026-10', '2026-09-12')).toBe(0);
  });
});
