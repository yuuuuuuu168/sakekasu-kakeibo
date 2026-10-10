import { normalizeMerchant } from './merchant';
import { TRANSFER_ID, UNCATEGORIZED_ID } from './categories';
import type { CategoryRule } from './types';

export type Classification = {
  categoryId: string;
  /** 1 回の支払いに複数カテゴリが混ざりうる店。内訳の確定を促す */
  ambiguous: boolean;
  ruleId?: string;
};

/**
 * ルールを 1 つ選ぶ。priority の降順、同値ならパターンの長い方が勝つ。
 * 「AMAZON PRIME」が「AMAZON」に負けないのはこの規則のため。
 */
export function pickRule(rawMerchant: string, rules: CategoryRule[], amount?: number): CategoryRule | undefined {
  const target = normalizeMerchant(rawMerchant);
  if (target === '') return undefined;

  const matched = rules.filter((rule) => meetsAmount(rule, amount) && matches(target, rawMerchant, rule));
  if (matched.length === 0) return undefined;

  return matched.sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    return normalizeMerchant(b.pattern).length - normalizeMerchant(a.pattern).length;
  })[0];
}

/** 下限額のあるルールは、金額が分かっていてそれ以上のときだけ当てる */
function meetsAmount(rule: CategoryRule, amount: number | undefined): boolean {
  if (rule.minAmount === undefined) return true;
  return amount !== undefined && amount >= rule.minAmount;
}

function matches(normalizedTarget: string, rawMerchant: string, rule: CategoryRule): boolean {
  if (rule.matchType === 'regex') {
    try {
      return new RegExp(rule.pattern, 'iu').test(rawMerchant);
    } catch {
      // 利用者が壊れた正規表現を保存してしまった場合。照合しないだけにして落とさない
      return false;
    }
  }
  const pattern = normalizeMerchant(rule.pattern);
  if (pattern === '') return false;
  if (rule.matchType === 'equals') return normalizedTarget === pattern;
  if (rule.matchType === 'startsWith') return normalizedTarget.startsWith(pattern);
  return normalizedTarget.includes(pattern);
}

export function classify(rawMerchant: string, rules: CategoryRule[], amount?: number): Classification {
  const rule = pickRule(rawMerchant, rules, amount);
  if (!rule) return { categoryId: UNCATEGORIZED_ID, ambiguous: false };
  return { categoryId: rule.categoryId, ambiguous: rule.ambiguous === true, ruleId: rule.id };
}

/**
 * 手で直したカテゴリをルールとして覚えてよいか。混ざる店（コンビニ、Amazon など）は覚えない。
 * 1 回の買い物を直しただけで「AMAZON は仕事・学習」と覚えると、以降の Amazon が全部そこへ流れる。
 */
export function shouldLearnRule(rawMerchant: string, rules: CategoryRule[]): boolean {
  if (normalizeMerchant(rawMerchant) === '') return false;
  return pickRule(rawMerchant, rules)?.ambiguous !== true;
}

/** 明細のカテゴリを直したときに作るルール。以降その店は同じカテゴリになる */
export function learnRule(rawMerchant: string, categoryId: string): CategoryRule {
  const pattern = normalizeMerchant(rawMerchant);
  return {
    id: `learned-${pattern.slice(0, 40)}`,
    pattern,
    matchType: 'equals',
    categoryId,
    priority: 100,
  };
}

type Seed = [pattern: string, categoryId: string, ambiguous?: true];

/**
 * 初期搭載ルール。国内の明細でよく出る店を並べただけのデータ。
 * ambiguous を立ててあるのは、1 回の支払いに複数カテゴリが混ざる店。
 * 分類自体は当たるが、それだけでは「何を買ったか」が分からないので内訳待ちにする。
 * 混ざる店は大カテゴリ止まりにしてある。小カテゴリはレシートの品目で決まる。
 */
const SEEDS: Seed[] = [
  // コンビニ。おにぎりとティッシュが混ざる、この家計簿の主題そのもの
  ['セブン-イレブン', 'food', true],
  ['セブンイレブン', 'food', true],
  ['ローソン', 'food', true],
  ['ファミリーマート', 'food', true],
  ['ミニストップ', 'food', true],
  ['デイリーヤマザキ', 'food', true],
  ['セイコーマート', 'food', true],
  ['ニューデイズ', 'food', true],

  // スーパー・ネットスーパー
  ['イオン', 'food', true],
  ['イトーヨーカドー', 'food', true],
  ['まいばすけっと', 'food', true],
  ['マルエツ', 'food', true],
  ['ライフ', 'food', true],
  ['サミット', 'food', true],
  ['西友', 'food', true],
  ['オーケー', 'food', true],
  ['業務スーパー', 'food', true],
  ['成城石井', 'food', true],
  ['コープ', 'food', true],
  ['オイシックス', 'food', true],

  // ドラッグストア。食品も日用品も薬も置いてある
  ['マツモトキヨシ', 'daily', true],
  ['スギ薬局', 'daily', true],
  ['サンドラッグ', 'daily', true],
  ['ウエルシア', 'daily', true],
  ['ツルハ', 'daily', true],
  ['ココカラファイン', 'daily', true],
  ['コスモス', 'daily', true],

  // 総合通販・量販・ホームセンター
  ['AMAZON', 'daily', true],
  ['楽天市場', 'daily', true],
  ['ヨドバシ', 'hobby-gadgets', true],
  ['ビックカメラ', 'hobby-gadgets', true],
  ['ドン・キホーテ', 'daily', true],
  ['ニトリ', 'daily-household', true],
  ['カインズ', 'daily-household', true],
  ['コーナン', 'daily-household', true],
  ['ハンズ', 'daily-household', true],
  ['ロフト', 'daily-household', true],
  ['無印良品', 'daily-household', true],
  ['ダイソー', 'daily-household', true],
  ['セリア', 'daily-household', true],

  // 会費。AMAZON より長いので先に当たる
  ['AMAZON PRIME', 'fees-membership'],
  ['KINDLE UNLIMITED', 'fees-membership'],
  ['KINDLE', 'hobby-books'],

  // 動画・音楽配信。YouTube は推し活の側に置く
  ['NETFLIX', 'hobby-streaming'],
  ['U-NEXT', 'hobby-streaming'],
  ['HULU', 'hobby-streaming'],
  ['ABEMA', 'hobby-streaming'],
  ['DAZN', 'hobby-streaming'],
  ['SPOTIFY', 'hobby-streaming'],
  // 中身が分からない請求。趣味・娯楽の大カテゴリ止まりにする
  ['APPLE COM BILL', 'hobby'],
  ['ITUNES', 'hobby'],

  // 推し活。Google 名義の請求はメンバーシップも Premium も区別が付かないのでまとめる
  ['GOOGLE', 'oshi-youtube'],
  ['YOUTUBE', 'oshi-youtube'],
  ['HOLOLIVE', 'oshi-hololive'],
  ['ホロライブ', 'oshi-hololive'],
  ['PIXIV', 'oshi-pixiv'],
  ['FANBOX', 'oshi-pixiv'],
  // DMM 名義はタイトルが出ないので、中身を問わずまとめる
  ['DMM', 'hobby-dmm'],
  ['FANZA', 'hobby-dmm'],

  // 仕事・学習。AWS は「LAWSON」に含まれてしまうので、正式名だけで当てる
  ['OPENAI', 'work-ai'],
  ['ANTHROPIC', 'work-ai'],
  ['CLAUDE', 'work-ai'],
  ['AMAZON WEB SERVICES', 'work-cloud'],
  ['ORACLE CLOUD', 'work-cloud'],
  ['AZURE', 'work-cloud'],
  ['お名前.com', 'work-cloud'],
  ['CLOUDFLARE', 'work-cloud'],
  ['GITHUB', 'work-devtools'],
  ['JETBRAINS', 'work-devtools'],
  ['DROPBOX', 'work-devtools'],
  ['NOTION', 'work-devtools'],
  ['ADOBE', 'work'],
  ['MICROSOFT', 'work'],

  // 外食。UBER EATS は UBER より長いので交通に取られない。居酒屋も外食に入れる
  ['UBER EATS', 'food-eatout'],
  ['出前館', 'food-eatout'],
  ['マクドナルド', 'food-eatout'],
  ['モスバーガー', 'food-eatout'],
  ['ケンタッキー', 'food-eatout'],
  ['すき家', 'food-eatout'],
  ['吉野家', 'food-eatout'],
  ['松屋', 'food-eatout'],
  ['なか卯', 'food-eatout'],
  ['サイゼリヤ', 'food-eatout'],
  ['ガスト', 'food-eatout'],
  ['バーミヤン', 'food-eatout'],
  ['丸亀製麺', 'food-eatout'],
  ['餃子の王将', 'food-eatout'],
  ['日高屋', 'food-eatout'],
  ['大戸屋', 'food-eatout'],
  ['CoCo壱番屋', 'food-eatout'],
  ['ラーメン', 'food-eatout'],
  ['食堂', 'food-eatout'],
  ['寿司', 'food-eatout'],
  ['居酒屋', 'food-eatout'],
  ['焼鳥', 'food-eatout'],
  ['ビアバー', 'food-eatout'],

  // カフェ
  ['スターバックス', 'food-cafe'],
  ['STARBUCKS', 'food-cafe'],
  ['ドトール', 'food-cafe'],
  ['タリーズ', 'food-cafe'],
  ['コメダ', 'food-cafe'],
  ['サンマルク', 'food-cafe'],
  ['エクセルシオール', 'food-cafe'],
  ['PRONTO', 'food-cafe'],
  ['カフェ', 'food-cafe'],

  // 交通。モバイルSuica はチャージなので下の TRANSFER_SEEDS に置いてある。
  // JR の 3,000 円以上は AMOUNT_SEEDS で新幹線に寄せる
  ['SUICA', 'transport-train'],
  ['PASMO', 'transport-train'],
  ['ICOCA', 'transport-train'],
  ['JR東日本', 'transport-train'],
  ['JR東海', 'transport-train'],
  ['JR西日本', 'transport-train'],
  ['東京メトロ', 'transport-train'],
  ['都営', 'transport-train'],
  ['小田急', 'transport-train'],
  ['京王', 'transport-train'],
  ['東急', 'transport-train'],
  ['えきねっと', 'transport-shinkansen'],
  ['EX予約', 'transport-shinkansen'],
  ['スマートEX', 'transport-shinkansen'],
  ['高速バス', 'transport-highway-bus'],
  ['夜行バス', 'transport-highway-bus'],
  ['WILLER', 'transport-highway-bus'],
  ['バスタ新宿', 'transport-highway-bus'],
  ['タクシー', 'transport-taxi'],
  ['GO TAXI', 'transport-taxi'],
  ['ANA', 'transport-flight'],
  ['JAL', 'transport-flight'],

  // 通信
  ['NTTドコモ', 'telecom-mobile'],
  ['ドコモ', 'telecom-mobile'],
  ['KDDI', 'telecom-mobile'],
  ['ソフトバンク', 'telecom-mobile'],
  ['楽天モバイル', 'telecom-mobile'],
  ['IIJ', 'telecom-mobile'],
  ['MINEO', 'telecom-mobile'],
  ['OCN', 'telecom-internet'],
  ['SO-NET', 'telecom-internet'],
  ['NTT東日本', 'telecom-internet'],

  // 住居・光熱
  ['東京電力', 'housing-electricity'],
  ['関西電力', 'housing-electricity'],
  ['中部電力', 'housing-electricity'],
  ['東京ガス', 'housing-gas'],
  ['大阪ガス', 'housing-gas'],
  ['水道局', 'housing-water'],
  ['家賃', 'housing-rent'],
  ['管理費', 'housing-rent'],

  // 健康・医療。スギ薬局のほうが長いのでドラッグストア扱いのまま
  ['クリニック', 'medical-clinic'],
  ['医院', 'medical-clinic'],
  ['病院', 'medical-clinic'],
  ['歯科', 'medical-clinic'],
  ['調剤', 'medical-clinic'],
  ['薬局', 'medical-clinic'],
  ['CHOCOZAP', 'medical-fitness'],
  ['ANYTIME FITNESS', 'medical-fitness'],
  ['ゴルフ', 'medical-fitness'],

  // 趣味・娯楽
  ['STEAM', 'hobby-games'],
  ['任天堂', 'hobby-games'],
  ['NINTENDO', 'hobby-games'],
  ['PLAYSTATION', 'hobby-games'],
  ['ゲオ', 'hobby-games'],
  ['TOHOシネマズ', 'hobby-events'],
  ['映画', 'hobby-events'],
  ['TSUTAYA', 'hobby-books'],
  ['紀伊國屋', 'hobby-books'],
  ['ジュンク堂', 'hobby-books'],
  ['丸善', 'hobby-books'],
  ['書店', 'hobby-books'],
  ['メルカリ', 'hobby'],
  ['APPLE STORE', 'hobby-gadgets'],

  // 衣類・散髪
  ['ユニクロ', 'apparel-clothes'],
  ['UNIQLO', 'apparel-clothes'],
  ['ジーユー', 'apparel-clothes'],
  ['ZOZO', 'apparel-clothes'],
  ['しまむら', 'apparel-clothes'],
  ['ABCマート', 'apparel-clothes'],
  ['QBハウス', 'apparel-haircut'],
  ['理容', 'apparel-haircut'],
  ['クリーニング', 'apparel-cleaning'],
];

/**
 * 金額で行き先が変わる店。JR はきっぷの買い方によって在来線も新幹線も同じ名前で出るので、
 * 1 回 3,000 円以上を新幹線とみなす。普段の電車でこの額を超えることはまず無く、
 * 新幹線は短い区間でもおおむね超える。定期券は買わない前提で線を引いている。
 * 同じパターンの金額なしルールより優先度を 1 つ上げ、金額を満たしたときだけ勝たせる。
 */
const SHINKANSEN_MIN_AMOUNT = 3000;

const AMOUNT_SEEDS: [pattern: string, categoryId: string, minAmount: number][] = [
  ['JR東日本', 'transport-shinkansen', SHINKANSEN_MIN_AMOUNT],
  ['JR東海', 'transport-shinkansen', SHINKANSEN_MIN_AMOUNT],
  ['JR西日本', 'transport-shinkansen', SHINKANSEN_MIN_AMOUNT],
];

/**
 * 残高へのチャージ。カード明細に出るこれらは支出ではなく、自分の残高への移動。
 * 「モバイルSuica」はカードの明細に出た時点でチャージそのものなので、店名だけで判る。
 * 優先度を普通の初期ルールより上げてあるのは、交通の「SUICA」に取られないため。
 * 同値だとパターンの長い方が勝つ規則があり、長さでは当てにできない。
 */
const TRANSFER_SEEDS: Seed[] = [
  ['チャージ', TRANSFER_ID],
  ['モバイルSuica', TRANSFER_ID],
  ['モバイルスイカ', TRANSFER_ID],
  ['モバイルPASMO', TRANSFER_ID],
  // ポイントやキャッシュバックの行。支出は買った額で数えるので、値引きにはせず集計から外す
  ['ポイント充当', TRANSFER_ID],
  ['ポイント利用', TRANSFER_ID],
  ['キャッシュバック', TRANSFER_ID],
];

/** チャージのルールの優先度。初期ルールの 10 と、利用者が付け替えて覚えさせる 100 の間 */
export const TRANSFER_PRIORITY = 20;

export const BUILTIN_RULES: CategoryRule[] = [
  ...SEEDS.map(([pattern, categoryId, ambiguous], index) => ({
    id: `builtin-${index}`,
    pattern,
    matchType: 'contains' as const,
    categoryId,
    ...(ambiguous ? { ambiguous: true as const } : {}),
    priority: 10,
    builtin: true,
  })),
  ...TRANSFER_SEEDS.map(([pattern, categoryId], index) => ({
    id: `builtin-transfer-${index}`,
    pattern,
    matchType: 'contains' as const,
    categoryId,
    priority: TRANSFER_PRIORITY,
    builtin: true,
  })),
  ...AMOUNT_SEEDS.map(([pattern, categoryId, minAmount], index) => ({
    id: `builtin-amount-${index}`,
    pattern,
    matchType: 'contains' as const,
    categoryId,
    minAmount,
    priority: 11,
    builtin: true,
  })),
];

/** 利用者のルールを初期搭載ルールより先に見る形で 1 本にする */
export function allRules(userRules: CategoryRule[]): CategoryRule[] {
  return [...userRules, ...BUILTIN_RULES];
}
