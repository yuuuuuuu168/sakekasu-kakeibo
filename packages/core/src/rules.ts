import { normalizeMerchant } from './merchant';
import { UNCATEGORIZED_ID } from './categories';
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
export function pickRule(rawMerchant: string, rules: CategoryRule[]): CategoryRule | undefined {
  const target = normalizeMerchant(rawMerchant);
  if (target === '') return undefined;

  const matched = rules.filter((rule) => matches(target, rawMerchant, rule));
  if (matched.length === 0) return undefined;

  return matched.sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    return normalizeMerchant(b.pattern).length - normalizeMerchant(a.pattern).length;
  })[0];
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

export function classify(rawMerchant: string, rules: CategoryRule[]): Classification {
  const rule = pickRule(rawMerchant, rules);
  if (!rule) return { categoryId: UNCATEGORIZED_ID, ambiguous: false };
  return { categoryId: rule.categoryId, ambiguous: rule.ambiguous === true, ruleId: rule.id };
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
  ['ヨドバシ', 'hobby', true],
  ['ビックカメラ', 'hobby', true],
  ['ドン・キホーテ', 'daily', true],
  ['ニトリ', 'daily', true],
  ['カインズ', 'daily', true],
  ['コーナン', 'daily', true],
  ['ハンズ', 'daily', true],
  ['ロフト', 'daily', true],
  ['無印良品', 'daily', true],
  ['ダイソー', 'daily', true],
  ['セリア', 'daily', true],

  // サブスク。AMAZON より長いので先に当たる
  ['AMAZON PRIME', 'subscription'],
  ['KINDLE', 'subscription'],
  ['NETFLIX', 'subscription'],
  ['SPOTIFY', 'subscription'],
  ['APPLE COM BILL', 'subscription'],
  ['ITUNES', 'subscription'],
  ['GOOGLE', 'subscription'],
  ['YOUTUBE', 'subscription'],
  ['ADOBE', 'subscription'],
  ['MICROSOFT', 'subscription'],
  ['DROPBOX', 'subscription'],
  ['NOTION', 'subscription'],
  ['OPENAI', 'subscription'],
  ['ANTHROPIC', 'subscription'],
  ['CLAUDE', 'subscription'],
  ['GITHUB', 'subscription'],
  ['AMAZON WEB SERVICES', 'subscription'],
  ['DAZN', 'subscription'],
  ['ABEMA', 'subscription'],
  ['U-NEXT', 'subscription'],
  ['HULU', 'subscription'],
  ['DMM', 'subscription'],

  // 外食。UBER EATS は UBER より長いので交通に取られない
  ['UBER EATS', 'eatout'],
  ['出前館', 'eatout'],
  ['マクドナルド', 'eatout'],
  ['モスバーガー', 'eatout'],
  ['ケンタッキー', 'eatout'],
  ['すき家', 'eatout'],
  ['吉野家', 'eatout'],
  ['松屋', 'eatout'],
  ['なか卯', 'eatout'],
  ['サイゼリヤ', 'eatout'],
  ['ガスト', 'eatout'],
  ['バーミヤン', 'eatout'],
  ['丸亀製麺', 'eatout'],
  ['餃子の王将', 'eatout'],
  ['日高屋', 'eatout'],
  ['大戸屋', 'eatout'],
  ['CoCo壱番屋', 'eatout'],
  ['ラーメン', 'eatout'],
  ['食堂', 'eatout'],
  ['寿司', 'eatout'],

  // カフェ・嗜好品
  ['スターバックス', 'cafe'],
  ['STARBUCKS', 'cafe'],
  ['ドトール', 'cafe'],
  ['タリーズ', 'cafe'],
  ['コメダ', 'cafe'],
  ['サンマルク', 'cafe'],
  ['エクセルシオール', 'cafe'],
  ['PRONTO', 'cafe'],
  ['カフェ', 'cafe'],

  // 酒。居酒屋は食事も酒も入るので内訳待ちにする
  ['居酒屋', 'alcohol', true],
  ['焼鳥', 'alcohol', true],
  ['酒販', 'alcohol'],
  ['リカー', 'alcohol'],
  ['やまや', 'alcohol'],
  ['カクヤス', 'alcohol'],
  ['ビアバー', 'alcohol'],

  // 交通
  ['モバイルSuica', 'transport'],
  ['SUICA', 'transport'],
  ['PASMO', 'transport'],
  ['ICOCA', 'transport'],
  ['JR東日本', 'transport'],
  ['東京メトロ', 'transport'],
  ['都営', 'transport'],
  ['小田急', 'transport'],
  ['京王', 'transport'],
  ['東急', 'transport'],
  ['タクシー', 'transport'],
  ['GO TAXI', 'transport'],
  ['ANA', 'transport'],
  ['JAL', 'transport'],
  ['NEXCO', 'transport'],
  ['ETC', 'transport'],
  ['タイムズ', 'transport'],
  ['駐車場', 'transport'],

  // 通信
  ['NTTドコモ', 'telecom'],
  ['ドコモ', 'telecom'],
  ['KDDI', 'telecom'],
  ['ソフトバンク', 'telecom'],
  ['楽天モバイル', 'telecom'],
  ['IIJ', 'telecom'],
  ['MINEO', 'telecom'],
  ['OCN', 'telecom'],
  ['SO-NET', 'telecom'],
  ['NTT東日本', 'telecom'],

  // 住居・光熱
  ['東京電力', 'housing'],
  ['関西電力', 'housing'],
  ['中部電力', 'housing'],
  ['東京ガス', 'housing'],
  ['大阪ガス', 'housing'],
  ['水道局', 'housing'],
  ['家賃', 'housing'],
  ['管理費', 'housing'],
  ['LOOOP', 'housing'],

  // 医療。スギ薬局のほうが長いのでドラッグストア扱いのまま
  ['クリニック', 'medical'],
  ['医院', 'medical'],
  ['病院', 'medical'],
  ['歯科', 'medical'],
  ['調剤', 'medical'],
  ['薬局', 'medical'],

  // 趣味・娯楽
  ['STEAM', 'hobby'],
  ['任天堂', 'hobby'],
  ['NINTENDO', 'hobby'],
  ['PLAYSTATION', 'hobby'],
  ['TOHOシネマズ', 'hobby'],
  ['映画', 'hobby'],
  ['ゲオ', 'hobby'],
  ['TSUTAYA', 'hobby'],
  ['紀伊國屋', 'hobby'],
  ['ジュンク堂', 'hobby'],
  ['丸善', 'hobby'],
  ['書店', 'hobby'],
  ['メルカリ', 'hobby'],
  ['APPLE STORE', 'hobby'],
  ['CHOCOZAP', 'hobby'],
  ['ANYTIME FITNESS', 'hobby'],
  ['ゴルフ', 'hobby'],

  // 衣類・美容
  ['ユニクロ', 'apparel'],
  ['UNIQLO', 'apparel'],
  ['ジーユー', 'apparel'],
  ['ZOZO', 'apparel'],
  ['しまむら', 'apparel'],
  ['ABCマート', 'apparel'],
  ['QBハウス', 'apparel'],
  ['美容室', 'apparel'],
  ['理容', 'apparel'],
  ['クリーニング', 'apparel'],
];

export const BUILTIN_RULES: CategoryRule[] = SEEDS.map(([pattern, categoryId, ambiguous], index) => ({
  id: `builtin-${index}`,
  pattern,
  matchType: 'contains' as const,
  categoryId,
  ...(ambiguous ? { ambiguous: true as const } : {}),
  priority: 10,
  builtin: true,
}));

/** 利用者のルールを初期搭載ルールより先に見る形で 1 本にする */
export function allRules(userRules: CategoryRule[]): CategoryRule[] {
  return [...userRules, ...BUILTIN_RULES];
}
