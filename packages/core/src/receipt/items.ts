import { UNCATEGORIZED_ID } from '../categories';

/**
 * レシートの品目名からカテゴリを当てる表。
 * OCR 側（Bedrock）も品目ごとにカテゴリを推定して返すが、外したり空で返したりするので、
 * こちらを後ろに置いて拾う。純粋な文字列照合なのでテストで固定できる。
 */
const ITEM_KEYWORDS: [keyword: string, categoryId: string][] = [
  // 食費
  ['おにぎり', 'food'], ['弁当', 'food'], ['サンドイッチ', 'food'], ['パン', 'food'],
  ['牛乳', 'food'], ['たまご', 'food'], ['卵', 'food'], ['納豆', 'food'], ['豆腐', 'food'],
  ['ヨーグルト', 'food'], ['チーズ', 'food'], ['ハム', 'food'], ['ソーセージ', 'food'],
  ['サラダ', 'food'], ['野菜', 'food'], ['キャベツ', 'food'], ['トマト', 'food'],
  ['バナナ', 'food'], ['りんご', 'food'], ['みかん', 'food'],
  ['肉', 'food'], ['豚', 'food'], ['鶏', 'food'], ['牛', 'food'], ['魚', 'food'], ['刺身', 'food'],
  ['うどん', 'food'], ['そば', 'food'], ['パスタ', 'food'], ['ラーメン', 'food'], ['カップ麺', 'food'],
  ['米', 'food'], ['味噌', 'food'], ['醤油', 'food'], ['調味', 'food'], ['冷凍', 'food'],
  ['惣菜', 'food'], ['総菜', 'food'], ['からあげ', 'food'], ['唐揚', 'food'], ['中華まん', 'food'],

  // カフェ・嗜好品
  ['コーヒー', 'cafe'], ['カフェラテ', 'cafe'], ['ラテ', 'cafe'], ['エスプレッソ', 'cafe'],
  ['紅茶', 'cafe'], ['緑茶', 'cafe'], ['お茶', 'cafe'], ['ジュース', 'cafe'], ['炭酸', 'cafe'],
  ['コーラ', 'cafe'], ['エナジー', 'cafe'], ['チョコ', 'cafe'], ['菓子', 'cafe'], ['スナック', 'cafe'],
  ['ポテトチップ', 'cafe'], ['クッキー', 'cafe'], ['ケーキ', 'cafe'], ['プリン', 'cafe'],
  ['アイス', 'cafe'], ['ガム', 'cafe'], ['グミ', 'cafe'], ['タバコ', 'cafe'], ['煙草', 'cafe'],

  // 酒
  ['ビール', 'alcohol'], ['発泡酒', 'alcohol'], ['日本酒', 'alcohol'], ['焼酎', 'alcohol'],
  ['ウイスキー', 'alcohol'], ['ワイン', 'alcohol'], ['ハイボール', 'alcohol'],
  ['チューハイ', 'alcohol'], ['サワー', 'alcohol'], ['梅酒', 'alcohol'], ['ジン', 'alcohol'],
  ['純米', 'alcohol'], ['吟醸', 'alcohol'], ['生酒', 'alcohol'],
  // 銘柄名は品目名にそのまま出るので、よく買うものだけ入れておく
  ['スーパードライ', 'alcohol'], ['一番搾り', 'alcohol'], ['金麦', 'alcohol'],
  ['氷結', 'alcohol'], ['ストロング', 'alcohol'], ['檸檬堂', 'alcohol'],

  // 日用品
  ['ティッシュ', 'daily'], ['トイレットペーパー', 'daily'], ['キッチンペーパー', 'daily'],
  ['洗剤', 'daily'], ['柔軟剤', 'daily'], ['シャンプー', 'daily'], ['リンス', 'daily'],
  ['コンディショナー', 'daily'], ['ボディソープ', 'daily'], ['石鹸', 'daily'], ['せっけん', 'daily'],
  ['歯ブラシ', 'daily'], ['歯磨き', 'daily'], ['ハミガキ', 'daily'],
  ['ゴミ袋', 'daily'], ['レジ袋', 'daily'], ['電池', 'daily'], ['マスク', 'daily'],
  ['綿棒', 'daily'], ['スポンジ', 'daily'], ['ラップ', 'daily'], ['ホイル', 'daily'],
  ['ウェット', 'daily'], ['消臭', 'daily'], ['芳香', 'daily'], ['カイロ', 'daily'],
  ['文房具', 'daily'], ['ノート', 'daily'], ['ボールペン', 'daily'], ['乾電池', 'daily'],

  // 医療
  ['風邪薬', 'medical'], ['胃薬', 'medical'], ['目薬', 'medical'], ['絆創膏', 'medical'],
  ['湿布', 'medical'], ['サプリ', 'medical'], ['ビタミン', 'medical'], ['マキロン', 'medical'],

  // 衣類・美容
  ['化粧', 'apparel'], ['コスメ', 'apparel'], ['日焼け止め', 'apparel'], ['口紅', 'apparel'],
  ['シャツ', 'apparel'], ['靴下', 'apparel'], ['下着', 'apparel'], ['コンタクト', 'apparel'],

  // 趣味・娯楽
  ['雑誌', 'hobby'], ['書籍', 'hobby'], ['コミック', 'hobby'], ['漫画', 'hobby'], ['新聞', 'hobby'],
];

/** 長いキーワードを先に見る。「カップ麺」が「麺」より先に当たるようにするため */
const SORTED_KEYWORDS = [...ITEM_KEYWORDS].sort((a, b) => b[0].length - a[0].length);

export function classifyItem(name: string, hint?: string): string {
  if (hint && hint !== UNCATEGORIZED_ID) return hint;
  if (!name) return UNCATEGORIZED_ID;
  const target = name.normalize('NFKC');
  for (const [keyword, categoryId] of SORTED_KEYWORDS) {
    if (target.includes(keyword)) return categoryId;
  }
  return UNCATEGORIZED_ID;
}
