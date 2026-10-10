import { childCategories, topLevelCategories, type Category } from '@kakeibo/core';

/**
 * カテゴリの選択肢。大カテゴリごとに `<optgroup>` で括り、その中に小カテゴリを並べる。
 * 平らに並べると「食費」と「食材」が同じ見た目になり、どれが大カテゴリか分からない。
 *
 * 大カテゴリそのものも選べるようにしておく。小カテゴリの決まらないもの（化粧品、サプリ、
 * 混ざる店の仮置き）は大カテゴリの直下に入るので、それを選べないと付け替えられない。
 * 小カテゴリを持たない大カテゴリ（未分類、振替など）は括らずにそのまま出す。
 */
export function CategoryOptions({ categories, exclude = [] }: { categories: Category[]; exclude?: string[] }) {
  const hidden = new Set(exclude);
  return (
    <>
      {topLevelCategories(categories)
        .filter((parent) => !hidden.has(parent.id))
        .map((parent) => {
          const children = childCategories(categories, parent.id).filter((child) => !hidden.has(child.id));
          if (children.length === 0) {
            return (
              <option key={parent.id} value={parent.id}>
                {parent.label}
              </option>
            );
          }
          return (
            <optgroup key={parent.id} label={parent.label}>
              <option value={parent.id}>{parent.label}（全般）</option>
              {children.map((child) => (
                <option key={child.id} value={child.id}>
                  {child.label}
                </option>
              ))}
            </optgroup>
          );
        })}
    </>
  );
}
