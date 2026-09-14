import { describe, expect, it } from 'vitest';
import { DUPLICATES_FILTER, NEEDS_DETAIL_FILTER, ROUTES, parseHash } from '../router';

describe('ROUTES', () => {
  it('タブは使う順に並び、設定は含まない', () => {
    expect(ROUTES.map((item) => item.name)).toEqual(['receipts', 'transactions', 'import', 'dashboard', 'report']);
    expect(ROUTES.map((item) => item.label)).toEqual([
      'レシート',
      '明細',
      '明細取り込み',
      'ダッシュボード',
      'レポート',
    ]);
  });

  it('どのタブも parseHash で自分に戻る', () => {
    for (const item of ROUTES) {
      expect(parseHash(item.path).name).toBe(item.name);
    }
  });
});

describe('parseHash', () => {
  it('既定の画面はレシート', () => {
    expect(parseHash('')).toEqual({ name: 'receipts' });
    expect(parseHash('#/')).toEqual({ name: 'receipts' });
    expect(parseHash('#/knowhere')).toEqual({ name: 'receipts' });
  });

  it('ダッシュボードは自分のパスを持つ', () => {
    expect(parseHash('#/dashboard')).toEqual({ name: 'dashboard' });
  });

  it('明細のクエリは今までどおり読む', () => {
    expect(parseHash('#/transactions?month=2026-09&filter=needsDetail')).toEqual({
      name: 'transactions',
      month: '2026-09',
      filter: 'needsDetail',
    });
  });

  it('組み込みの絞り込みをそのまま渡す', () => {
    expect(parseHash(`#/transactions?filter=${NEEDS_DETAIL_FILTER}`).name).toBe('transactions');
    expect(parseHash(`#/transactions?month=2026-09&filter=${DUPLICATES_FILTER}`)).toEqual({
      name: 'transactions',
      month: '2026-09',
      filter: 'duplicates',
    });
  });

  it('レポートの月も今までどおり読む', () => {
    expect(parseHash('#/report?month=2026-08')).toEqual({ name: 'report', month: '2026-08' });
  });

  it('設定を開く。タブから外した #/categories も設定へ送る', () => {
    expect(parseHash('#/settings')).toEqual({ name: 'settings' });
    expect(parseHash('#/categories')).toEqual({ name: 'settings' });
  });
});
