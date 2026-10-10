import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { DISCOUNT_ID, SEED_CATEGORIES, TRANSFER_ID, UNCATEGORIZED_ID } from '@kakeibo/core';
import { CategoryOptions } from '../CategoryOptions';

function renderSelect(exclude?: string[]) {
  const { container } = render(
    <select aria-label="カテゴリ">
      <CategoryOptions categories={SEED_CATEGORIES} exclude={exclude} />
    </select>,
  );
  return container.querySelector('select') as HTMLSelectElement;
}

describe('CategoryOptions', () => {
  it('大カテゴリごとに括り、その中に小カテゴリを並べる', () => {
    const select = renderSelect();
    const groups = [...select.querySelectorAll('optgroup')];
    expect(groups.map((group) => group.label)).toHaveLength(13);

    const food = groups.find((group) => group.label === '食費');
    expect([...(food?.querySelectorAll('option') ?? [])].map((option) => option.textContent)).toEqual([
      '食費（全般）',
      '食材',
      '中食',
      '外食',
      'カフェ',
      '飲み物・お菓子',
      '酒',
    ]);
  });

  it('大カテゴリそのものも選べる', () => {
    const select = renderSelect();
    expect([...select.options].some((option) => option.value === 'food')).toBe(true);
  });

  it('小カテゴリの無い値引き・振替・未分類は括らずに出す', () => {
    const select = renderSelect();
    const loose = [...select.children].filter((child) => child.tagName === 'OPTION') as HTMLOptionElement[];
    expect(loose.map((option) => option.value)).toEqual([DISCOUNT_ID, TRANSFER_ID, UNCATEGORIZED_ID]);
  });

  it('外したカテゴリは出さない', () => {
    const select = renderSelect([UNCATEGORIZED_ID]);
    expect([...select.options].some((option) => option.value === UNCATEGORIZED_ID)).toBe(false);
  });
});
