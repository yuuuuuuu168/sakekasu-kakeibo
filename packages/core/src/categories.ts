import type { Category } from './types';

export const UNCATEGORIZED_ID = 'uncategorized';

/**
 * 残高へのチャージを入れるカテゴリ。PayPay や Suica の残高に移しただけの金は支出ではないので、
 * カテゴリ別の実績と上限からは外す。支出として数えるのは残高側の利用明細のほう。
 * 普通のカテゴリとして持たせてあるのは、画面の付け替えとルール学習がそのまま使えるから。
 */
export const TRANSFER_ID = 'transfer';

/**
 * 配送料。Amazon の「配送料 200 / 割引 -200」のように送料と同じ額の割引が付いたとき、
 * 割引をここに寄せて相殺する（`splitsFromReceipt`）。品目に配ると商品が安く見えてしまう。
 */
export const SHIPPING_ID = 'fees-shipping';

type Seed = [id: string, label: string, children: [id: string, label: string][]];

/**
 * 初期カテゴリ。大カテゴリ 13 個と、その下の小カテゴリ。分け方は「何に使ったか」の 1 本に揃えてある。
 * 上限は大カテゴリにしか付けられないので、上限を付けたいものは大カテゴリに立てる（推し活がそう）。
 * 外食・カフェ・酒を食費の下に置いたのも同じ理由で、食費全体で見張れば足りるという判断。
 *
 * 小カテゴリの ID には親の ID を前に付ける。利用者が画面で足すカテゴリ（`c-…`）とも、
 * 大カテゴリ同士とも衝突しないようにするため。
 * 化粧品やサプリのように小カテゴリを作らなかったものは、大カテゴリの直下に入る。
 * 判定で小カテゴリまで決まらなかったときも同じで、そこが実質「その他」になる。
 */
const SEED_TREE: Seed[] = [
  ['food', '食費', [
    ['food-groceries', '食材'],
    ['food-deli', '中食'],
    ['food-eatout', '外食'],
    ['food-cafe', 'カフェ'],
    ['food-snacks', '飲み物・お菓子'],
    ['food-alcohol', '酒'],
  ]],
  ['daily', '日用品', [
    ['daily-consumables', '消耗品'],
    ['daily-household', '生活雑貨'],
  ]],
  ['apparel', '衣類・散髪', [
    ['apparel-clothes', '衣類'],
    ['apparel-haircut', '散髪'],
    ['apparel-cleaning', 'クリーニング'],
  ]],
  ['medical', '健康・医療', [
    ['medical-clinic', '通院・薬'],
    ['medical-fitness', 'ジム・運動'],
  ]],
  ['transport', '交通', [
    ['transport-train', '電車'],
    ['transport-bus', 'バス'],
    ['transport-shinkansen', '新幹線'],
    ['transport-highway-bus', '高速バス'],
    ['transport-taxi', 'タクシー'],
    ['transport-flight', '飛行機'],
  ]],
  ['housing', '住居・光熱', [
    ['housing-rent', '家賃・管理費'],
    ['housing-electricity', '電気'],
    ['housing-gas', 'ガス'],
    ['housing-water', '水道'],
  ]],
  ['telecom', '通信', [
    ['telecom-mobile', '携帯'],
    ['telecom-internet', 'ネット回線'],
  ]],
  ['hobby', '趣味・娯楽', [
    ['hobby-books', '本・漫画'],
    ['hobby-events', '映画・イベント'],
    ['hobby-streaming', '動画・音楽配信'],
    ['hobby-games', 'ゲーム'],
    ['hobby-gadgets', 'ガジェット'],
    ['hobby-dmm', 'DMM'],
  ]],
  ['oshi', '推し活', [
    ['oshi-hololive', 'ホロライブ'],
    ['oshi-youtube', 'Google/YouTube'],
    ['oshi-pixiv', 'Pixiv/Fanbox'],
  ]],
  ['work', '仕事・学習', [
    ['work-ai', 'AI'],
    ['work-cloud', 'クラウド利用料'],
    ['work-devtools', '開発ツール'],
    ['work-courses', '講座・資格'],
    ['work-books', '参考書'],
  ]],
  ['social', '交際費', [
    ['social-dining', '会食'],
    ['social-gifts', 'プレゼント・お祝い'],
  ]],
  ['special', '特別費', [
    ['special-travel', '旅行'],
    ['special-furniture', '家電・家具'],
  ]],
  ['fees', '手数料・年会費', [
    ['fees-bank', '手数料'],
    ['fees-membership', '年会費・会費'],
    ['fees-shipping', '配送料'],
  ]],
];

/** 並び順は大カテゴリを 100 刻みにして、小カテゴリをその間に入れる */
export const SEED_CATEGORIES: Category[] = [
  ...SEED_TREE.flatMap(([id, label, children], index): Category[] => {
    const order = (index + 1) * 100;
    return [
      { id, label, order },
      ...children.map(([childId, childLabel], position) => ({
        id: childId,
        label: childLabel,
        order: order + position + 1,
        parentId: id,
      })),
    ];
  }),
  { id: TRANSFER_ID, label: '振替・チャージ', order: 9000 },
  { id: UNCATEGORIZED_ID, label: '未分類', order: 9900 },
];

export function categoryLabel(categories: Category[], id: string): string {
  return categories.find((category) => category.id === id)?.label ?? id;
}

export function activeCategories(categories: Category[]): Category[] {
  return categories.filter((category) => !category.archived).sort((a, b) => a.order - b.order);
}

/**
 * 親をたどる回数の上限。カテゴリは 2 段までのつもりだが、保存済みのデータが
 * その形をしている保証は無い（親を消した、循環させた、孫を作った）。
 * 集計が落ちたり額が消えたりする方が困るので、番犬を置いて必ず止める。
 */
const MAX_DEPTH = 8;

/** 小カテゴリを吊れないカテゴリ。支出として数えない入れ物なので、分解する意味が無い */
const NO_CHILDREN = new Set([TRANSFER_ID, UNCATEGORIZED_ID]);

/**
 * その ID を上限とレポートで数える先。小カテゴリなら親の ID、大カテゴリなら自分の ID。
 * 親が見つからない、循環している、階層が深すぎる、といった壊れた形では途中で止めて
 * たどれたところを返す。返り値が必ず存在する ID になるとは限らない（消えたカテゴリの
 * 内訳がそのまま残ることがある）が、額が宙に浮くことは無い。
 */
export function rootCategoryId(categories: Category[], id: string): string {
  return rootIn(new Map(categories.map((category) => [category.id, category])), id);
}

function rootIn(byId: Map<string, Category>, id: string): string {
  let current = byId.get(id);
  if (!current) return id;
  const seen = new Set<string>([id]);

  for (let depth = 0; current.parentId && depth < MAX_DEPTH; depth += 1) {
    if (seen.has(current.parentId)) break;
    const parent = byId.get(current.parentId);
    // 親を統合して使わなくなったときは、子をそのまま大カテゴリとして立てる。
    // 消えた親に寄せると、集計の行にも画面の一覧にも出てこないカテゴリができる
    if (!parent || parent.archived) break;
    seen.add(parent.id);
    current = parent;
  }
  return current.id;
}

/** 大カテゴリだけを並べる。上限を入れる単位でもある */
export function topLevelCategories(categories: Category[]): Category[] {
  const byId = new Map(categories.map((category) => [category.id, category]));
  return activeCategories(categories).filter((category) => rootIn(byId, category.id) === category.id);
}

/** ある大カテゴリの小カテゴリ。孫は含めない（2 段までの運用なので直下だけ見る） */
export function childCategories(categories: Category[], parentId: string): Category[] {
  return activeCategories(categories).filter((category) => category.parentId === parentId);
}

export function hasChildren(categories: Category[], parentId: string): boolean {
  return categories.some((category) => !category.archived && category.parentId === parentId);
}

/**
 * カテゴリ別の集計を大カテゴリの単位に寄せる。小カテゴリの額は親に足し込む。
 * 上限とレポートの粒度を大カテゴリに据えてあるので、集計の側で寄せる。
 */
export function rollUpTotals(totals: Map<string, number>, categories: Category[]): Map<string, number> {
  const byId = new Map(categories.map((category) => [category.id, category]));
  const rolled = new Map<string, number>();
  for (const [id, amount] of totals) {
    const root = rootIn(byId, id);
    rolled.set(root, (rolled.get(root) ?? 0) + amount);
  }
  return rolled;
}

/** 上限も同じように寄せる。小カテゴリに上限が残っていても、どの行にも紐付かない額にしない */
export function rollUpLimits(limits: Record<string, number>, categories: Category[]): Record<string, number> {
  const byId = new Map(categories.map((category) => [category.id, category]));
  const rolled: Record<string, number> = {};
  for (const [id, limit] of Object.entries(limits)) {
    const root = rootIn(byId, id);
    rolled[root] = (rolled[root] ?? 0) + limit;
  }
  return rolled;
}

/**
 * その親の下に置いてよいかを確かめる。画面から壊れた形を作らせないための門。
 * 断るのは、自分自身、既に小カテゴリになっている相手（3 段目になる）、
 * 小カテゴリを抱えている自分（その子が孫になる）、未分類と振替、存在しない ID。
 * 親は必ず大カテゴリ、子は必ず子を持たない、という 2 つを守れば循環も起きない。
 */
export function canAdopt(categories: Category[], childId: string, parentId: string): boolean {
  if (childId === parentId) return false;
  if (NO_CHILDREN.has(parentId) || NO_CHILDREN.has(childId)) return false;

  const byId = new Map(categories.map((category) => [category.id, category]));
  const parent = byId.get(parentId);
  if (!parent || parent.archived || !byId.has(childId)) return false;
  if (parent.parentId) return false;

  return !hasChildren(categories, childId);
}

/**
 * カテゴリの統合。from を to に寄せ、明細の内訳も付け替える。
 * 統合後に同じカテゴリの内訳が 2 行並ぶことがあるので、まとめる。
 */
export function mergeCategoryInSplits<T extends { splits: { categoryId: string; amount: number; id: string; name?: string; origin: string }[] }>(
  transactions: T[],
  fromId: string,
  toId: string,
): T[] {
  return transactions.map((txn) => {
    if (!txn.splits.some((split) => split.categoryId === fromId)) return txn;
    const moved = txn.splits.map((split) =>
      split.categoryId === fromId ? { ...split, categoryId: toId } : split,
    );
    return { ...txn, splits: coalesce(moved) };
  });
}

function coalesce<S extends { categoryId: string; amount: number; id: string; name?: string }>(splits: S[]): S[] {
  // 品目名が付いている内訳（レシート由来）は何を買ったかの情報なので、まとめない
  const named = splits.filter((split) => split.name);
  const unnamed = splits.filter((split) => !split.name);
  const byCategory = new Map<string, S>();
  for (const split of unnamed) {
    const found = byCategory.get(split.categoryId);
    if (found) {
      byCategory.set(split.categoryId, { ...found, amount: found.amount + split.amount });
    } else {
      byCategory.set(split.categoryId, split);
    }
  }
  return [...named, ...byCategory.values()];
}
