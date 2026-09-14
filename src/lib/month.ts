import { addMonths } from '@kakeibo/core';

export function todayIso(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

export function currentMonth(): string {
  return todayIso().slice(0, 7);
}

/** 月をずらす。中身は packages/core の addMonths（Lambda と同じ計算を 2 回書かない） */
export const shiftMonth = addMonths;

export function formatMonth(month: string): string {
  const [year, mon] = month.split('-');
  return `${year}年${Number(mon)}月`;
}
