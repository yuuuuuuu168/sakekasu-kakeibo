import { childCategories, topLevelCategories, UNCATEGORIZED_ID, type Category } from '@kakeibo/core';

/**
 * カテゴリの選択肢。大カテゴリごとに `<optgroup>` で括り、その中に小カテゴリを並べる。
 * 平らに並べると「食費」と「食材」が同じ見た目になり、どれが大カテゴリか分からない。
 *
 * 大カテゴリそのものも選べるようにしておく。小カテゴリの決まらないもの（化粧品、サプリ、
 * 混ざる店の仮置き）は大カテゴリの直下に入るので、それを選べないと付け替えられない。
 * 小カテゴリを持たない大カテゴリ（未分類、振替など）は括らずにそのまま出す。
 *
 * 「未分類」は order が一番大きく一覧の最後に並ぶが、新しい明細の初期値でもあるため、
 * 選択肢としては先頭に出す。一番下から始まると、実際によく選ぶ上の方のカテゴリまで
 * 毎回スクロールすることになる。order 自体は集計・レポートの並びに使うのでここでは変えない。
 */
export function CategoryOptions({ categories, exclude = [] }: { categories: Category[]; exclude?: string[] }) {
  const hidden = new Set(exclude);
  const top = topLevelCategories(categories).filter((parent) => !hidden.has(parent.id));
  const uncategorized = top.find((parent) => parent.id === UNCATEGORIZED_ID);
  const ordered = uncategorized ? [uncategorized, ...top.filter((parent) => parent.id !== UNCATEGORIZED_ID)] : top;
  return (
    <>
      {ordered.map((parent) => {
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
