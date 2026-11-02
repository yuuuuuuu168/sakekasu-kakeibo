/**
 * クリップボードからレシートの画像を取り出す。PC でスクリーンショットやブラウザの画像をコピーして
 * そのまま読ませるため。読める形式かどうかは選んだ写真と同じく onImages で見る。
 */

/** paste イベントの中身から画像だけを取り出す。文字だけなら空 */
export function pastedImages(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files: File[] = [];
  for (const item of [...data.items]) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (file) files.push(named(file, files.length));
  }
  return files;
}

/**
 * ボタンから読むとき。navigator.clipboard.read() は許可を求めるので、断られたら投げる。
 * 対応していないブラウザ（古い Firefox など）でも投げる
 */
export async function clipboardImages(): Promise<File[]> {
  if (!navigator.clipboard?.read) throw new Error('クリップボードの読み取りに対応していません');
  const items = await navigator.clipboard.read();
  const files: File[] = [];
  for (const item of items) {
    const type = item.types.find((t) => t.startsWith('image/'));
    if (!type) continue;
    const blob = await item.getType(type);
    files.push(named(new File([blob], '', { type }), files.length));
  }
  return files;
}

/** 貼り付けた画像は名前が無いか、どれも image.png になる。見分けがつくように付け直す */
function named(file: File, index: number): File {
  const ext = file.type.split('/')[1] ?? 'png';
  return new File([file], `pasted-${index + 1}.${ext}`, { type: file.type, lastModified: file.lastModified });
}
