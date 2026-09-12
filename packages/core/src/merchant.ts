/**
 * 明細の店舗名は表記が荒れている。半角カナ、全角英数、末尾の店舗番号、
 * Amazon の注文 ID など。ルールの照合と名寄せのために 1 つの形に寄せる。
 */

/** 注文 ID らしい塊。「*」や「-」で区切られた 4 文字以上の英数字混在 */
const ORDER_ID = /[*＊][A-Z0-9]{4,}/g;
/** 4 桁以上の数字の連続。店舗番号、伝票番号、電話番号の断片 */
const LONG_DIGITS = /\d{4,}/g;
/** 末尾に残った短い数字。「セブンイレブン 1234」の類 */
const TRAILING_DIGITS = /[\s\-/]*\d{1,3}$/;
/** 文字でも数字でもないもの。空白、記号、中点 */
const NON_ALNUM = /[^\p{L}\p{N}]/gu;

export function normalizeMerchant(raw: string): string {
  if (!raw) return '';
  let text = raw.normalize('NFKC').toUpperCase().trim();
  text = text.replace(ORDER_ID, ' ');
  text = text.replace(LONG_DIGITS, ' ');
  text = text.replace(TRAILING_DIGITS, '');
  text = text.replace(NON_ALNUM, '');
  return text;
}

/**
 * 店舗名の近さを 0〜1 で返す。レシートと明細の突き合わせに使う。
 * 一方が他方を含んでいれば、短い側の長さの割合で評価する。
 * 完全に別物でも、先頭 3 文字が一致していれば弱く点を与える（チェーン名の頭は合うことが多い）。
 */
export function merchantSimilarity(a: string, b: string): number {
  const left = normalizeMerchant(a);
  const right = normalizeMerchant(b);
  if (left === '' || right === '') return 0;
  if (left === right) return 1;

  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  if (longer.includes(shorter)) {
    return Math.max(0.5, shorter.length / longer.length);
  }

  const head = Math.min(3, shorter.length);
  if (shorter.slice(0, head) === longer.slice(0, head)) return 0.25;
  return 0;
}
