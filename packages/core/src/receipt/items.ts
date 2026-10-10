import { UNCATEGORIZED_ID } from '../categories';

/**
 * レシートの品目名からカテゴリを当てる表。
 * OCR 側（Bedrock）も品目ごとにカテゴリを推定して返すが、外したり空で返したりするので、
 * こちらを後ろに置いて拾う。純粋な文字列照合なのでテストで固定できる。
 *
 * 本命の判定は Jev で、ここは判定が使えないときの最後の手段。拾えるものだけ拾い、
 * 書名やイベント名で分けるもの（参考書、推し活のチケット）は判定に任せる。
 * 部分一致なので、短い語は別の語に紛れ込む。「ノート」は「ノートPC」に、
 * 「ラップ」は「ストラップ」に当たっていたので外すか、長い語を足して先に当てている。
 */
const ITEM_KEYWORDS: [keyword: string, categoryId: string][] = [
  // 食費 / 食材
  ['パン', 'food-groceries'], ['牛乳', 'food-groceries'], ['たまご', 'food-groceries'], ['卵', 'food-groceries'],
  ['納豆', 'food-groceries'], ['豆腐', 'food-groceries'], ['ヨーグルト', 'food-groceries'], ['チーズ', 'food-groceries'],
  ['ハム', 'food-groceries'], ['ソーセージ', 'food-groceries'], ['野菜', 'food-groceries'], ['キャベツ', 'food-groceries'],
  ['トマト', 'food-groceries'], ['バナナ', 'food-groceries'], ['りんご', 'food-groceries'], ['みかん', 'food-groceries'],
  ['肉', 'food-groceries'], ['豚', 'food-groceries'], ['鶏', 'food-groceries'], ['牛', 'food-groceries'],
  ['魚', 'food-groceries'], ['刺身', 'food-groceries'], ['うどん', 'food-groceries'], ['そば', 'food-groceries'],
  ['パスタ', 'food-groceries'], ['ラーメン', 'food-groceries'], ['カップ麺', 'food-groceries'], ['米', 'food-groceries'],
  ['味噌', 'food-groceries'], ['醤油', 'food-groceries'], ['調味', 'food-groceries'], ['冷凍', 'food-groceries'],

  // 食費 / 中食。「冷凍弁当」は「冷凍」より長いので先に当たる
  ['おにぎり', 'food-deli'], ['弁当', 'food-deli'], ['冷凍弁当', 'food-deli'], ['サンドイッチ', 'food-deli'],
  ['サラダ', 'food-deli'], ['惣菜', 'food-deli'], ['総菜', 'food-deli'], ['からあげ', 'food-deli'],
  ['唐揚', 'food-deli'], ['中華まん', 'food-deli'],

  // 食費 / カフェ。店で飲むもの、コンビニのカウンターコーヒー
  ['コーヒー', 'food-cafe'], ['カフェラテ', 'food-cafe'], ['ラテ', 'food-cafe'], ['エスプレッソ', 'food-cafe'],
  ['フラペチーノ', 'food-cafe'],

  // 食費 / 飲み物・お菓子。家で飲むコーヒーはこちら
  ['ドリップコーヒー', 'food-snacks'], ['水出しコーヒー', 'food-snacks'], ['インスタントコーヒー', 'food-snacks'],
  ['コーヒー豆', 'food-snacks'], ['紅茶', 'food-snacks'], ['緑茶', 'food-snacks'], ['お茶', 'food-snacks'],
  ['ほうじ茶', 'food-snacks'], ['ジュース', 'food-snacks'], ['炭酸', 'food-snacks'], ['タンサン', 'food-snacks'],
  ['コーラ', 'food-snacks'], ['エナジー', 'food-snacks'], ['チョコ', 'food-snacks'], ['菓子', 'food-snacks'],
  ['スナック', 'food-snacks'], ['ポテトチップ', 'food-snacks'], ['クッキー', 'food-snacks'], ['ケーキ', 'food-snacks'],
  ['プリン', 'food-snacks'], ['アイス', 'food-snacks'], ['ガム', 'food-snacks'], ['グミ', 'food-snacks'],

  // 食費 / 酒。買って飲む分だけ。店で飲んだ分は外食
  ['ビール', 'food-alcohol'], ['発泡酒', 'food-alcohol'], ['日本酒', 'food-alcohol'], ['焼酎', 'food-alcohol'],
  ['ウイスキー', 'food-alcohol'], ['ワイン', 'food-alcohol'], ['ハイボール', 'food-alcohol'],
  ['チューハイ', 'food-alcohol'], ['サワー', 'food-alcohol'], ['梅酒', 'food-alcohol'], ['ジン', 'food-alcohol'],
  ['純米', 'food-alcohol'], ['吟醸', 'food-alcohol'], ['生酒', 'food-alcohol'],
  // 銘柄名は品目名にそのまま出るので、よく買うものだけ入れておく
  ['スーパードライ', 'food-alcohol'], ['一番搾り', 'food-alcohol'], ['金麦', 'food-alcohol'],
  ['氷結', 'food-alcohol'], ['ストロング', 'food-alcohol'], ['檸檬堂', 'food-alcohol'],

  // 日用品 / 消耗品
  ['ティッシュ', 'daily-consumables'], ['トイレットペーパー', 'daily-consumables'], ['キッチンペーパー', 'daily-consumables'],
  ['洗剤', 'daily-consumables'], ['柔軟剤', 'daily-consumables'], ['シャンプー', 'daily-consumables'],
  ['リンス', 'daily-consumables'], ['コンディショナー', 'daily-consumables'], ['ボディソープ', 'daily-consumables'],
  ['洗顔', 'daily-consumables'], ['石鹸', 'daily-consumables'], ['せっけん', 'daily-consumables'],
  ['歯ブラシ', 'daily-consumables'], ['歯磨き', 'daily-consumables'], ['ハミガキ', 'daily-consumables'],
  ['ゴミ袋', 'daily-consumables'], ['レジ袋', 'daily-consumables'], ['電池', 'daily-consumables'],
  ['乾電池', 'daily-consumables'], ['マスク', 'daily-consumables'], ['綿棒', 'daily-consumables'],
  ['スポンジ', 'daily-consumables'], ['ラップ', 'daily-consumables'], ['ホイル', 'daily-consumables'],
  ['ウェット', 'daily-consumables'], ['消臭', 'daily-consumables'], ['芳香', 'daily-consumables'],
  ['カイロ', 'daily-consumables'],

  // 日用品 / 生活雑貨。「ストラップ」は「ラップ」より長いので先に当たる
  ['タオル', 'daily-household'], ['枕', 'daily-household'], ['ストラップ', 'daily-household'],
  ['文房具', 'daily-household'], ['ボールペン', 'daily-household'],

  // 日用品（小カテゴリなし）。化粧品は小カテゴリを作らず大カテゴリの直下に入れる
  ['化粧', 'daily'], ['コスメ', 'daily'], ['日焼け止め', 'daily'], ['口紅', 'daily'],

  // 衣類・散髪 / 衣類
  ['シャツ', 'apparel-clothes'], ['靴下', 'apparel-clothes'], ['下着', 'apparel-clothes'],

  // 健康・医療
  ['風邪薬', 'medical-clinic'], ['胃薬', 'medical-clinic'], ['目薬', 'medical-clinic'], ['絆創膏', 'medical-clinic'],
  ['湿布', 'medical-clinic'], ['マキロン', 'medical-clinic'],
  ['サプリ', 'medical'], ['ビタミン', 'medical'], ['コンタクト', 'medical'],
  ['ステッパー', 'medical-fitness'],

  // 趣味・娯楽
  ['雑誌', 'hobby-books'], ['書籍', 'hobby-books'], ['コミック', 'hobby-books'], ['COMICS', 'hobby-books'],
  ['漫画', 'hobby-books'], ['文庫', 'hobby-books'], ['新聞', 'hobby-books'],
  ['ANKER', 'hobby-gadgets'], ['充電器', 'hobby-gadgets'], ['モバイルバッテリー', 'hobby-gadgets'],

  // 推し活
  ['HOLOLIVE', 'oshi-hololive'], ['ホロライブ', 'oshi-hololive'],

  // 手数料・年会費
  ['KINDLE UNLIMITED', 'fees-membership'],
  ['送料', 'fees-shipping'], ['配送料', 'fees-shipping'], ['配送手数料', 'fees-shipping'],
];

function normalize(text: string): string {
  return text.normalize('NFKC').toUpperCase();
}

/**
 * 品目名の照合に使う形。全角半角と大文字小文字、空白の揺れだけを吸収する。
 * 店舗名の正規化（normalizeMerchant）は数字を落とすので使わない。
 * 品目名の数字（「コーラ 500ml」「卵 10個」）は中身を分ける手がかりになる。
 */
export function normalizeItemName(name: string): string {
  return normalize(name).replace(/\s+/g, '');
}

/** 長いキーワードを先に見る。「カップ麺」が「麺」より先に当たるようにするため */
const SORTED_KEYWORDS = ITEM_KEYWORDS.map(([keyword, categoryId]) => [normalize(keyword), categoryId] as const).sort(
  (a, b) => b[0].length - a[0].length,
);

export function classifyItem(name: string, hint?: string): string {
  if (hint && hint !== UNCATEGORIZED_ID) return hint;
  if (!name) return UNCATEGORIZED_ID;
  const target = normalize(name);
  for (const [keyword, categoryId] of SORTED_KEYWORDS) {
    if (target.includes(keyword)) return categoryId;
  }
  return UNCATEGORIZED_ID;
}
