import { isReceiptImageType } from '@kakeibo/core';

/**
 * レシートの写真を、送る前にブラウザで縮める。
 *
 * OCR のモデル（Claude Sonnet 5.5）が読めるのは長辺 2576px・約 375 万画素まで。それより大きい写真は
 * サーバ側で縮められるだけなので、ここで同じ大きさに縮めても読める字は変わらない。縮めると
 * - 1 枚 5MB の上限（Claude API も Bedrock も）に引っかからなくなる。スマホの写真はそのままだと超えることがある
 * - アップロードが速くなる（最大 4 枚を送る）
 * - JPEG に書き直すので、写真の向き（EXIF）が画素に反映され、位置情報などのメタデータも落ちる
 *
 * 縮める必要の無い小さい写真（スクリーンショットなど）は、JPEG に書き直すとかえって大きくなることがある。
 * そのときは、元の形式がそのまま読める（JPEG・PNG・WebP）なら元のファイルを返す。
 *
 * 縮められなかったとき（読めない形式、古いブラウザ）は元のファイルをそのまま返す。
 * 送るかどうかは呼び出し側が形式で決める（読めない形式はそこで断る）。
 */

/** モデルが読める長辺の上限 */
export const PHOTO_MAX_LONG_EDGE = 2576;
/** モデルが読める画素数の上限 */
export const PHOTO_MAX_PIXELS = 3_750_000;
/** 感熱紙の細い字が潰れない程度の画質 */
export const PHOTO_JPEG_QUALITY = 0.9;

/** 縮めた後の大きさ。長辺と画素数の両方の上限に収める。元のほうが小さければそのまま */
export function targetSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, PHOTO_MAX_LONG_EDGE / Math.max(width, height), Math.sqrt(PHOTO_MAX_PIXELS / (width * height)));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

type Decoded = { width: number; height: number; close?: () => void };

/** 画像の読み込みと書き出し。テストから差し替えられるように分けてある */
export type PhotoCodec = {
  decode: (file: Blob) => Promise<Decoded>;
  encode: (image: Decoded, size: { width: number; height: number }, quality: number) => Promise<Blob>;
};

const browserCodec: PhotoCodec = {
  // createImageBitmap は既定で EXIF の向きを反映する（imageOrientation: 'from-image'）
  decode: (file) => createImageBitmap(file),
  encode: (image, size, quality) =>
    new Promise((resolve, reject) => {
      const canvas = document.createElement('canvas');
      canvas.width = size.width;
      canvas.height = size.height;
      const context = canvas.getContext('2d');
      if (!context) {
        reject(new Error('canvas が使えません'));
        return;
      }
      context.imageSmoothingQuality = 'high';
      context.drawImage(image as CanvasImageSource, 0, 0, size.width, size.height);
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('JPEG に書き出せません'))), 'image/jpeg', quality);
    }),
};

export async function shrinkPhoto(file: File, codec: PhotoCodec = browserCodec): Promise<Blob> {
  let image: Decoded | undefined;
  try {
    image = await codec.decode(file);
    const size = targetSize(image.width, image.height);
    const jpeg = await codec.encode(image, size, PHOTO_JPEG_QUALITY);
    const resized = size.width !== image.width || size.height !== image.height;
    return !resized && isReceiptImageType(file.type) && jpeg.size >= file.size ? file : jpeg;
  } catch {
    return file;
  } finally {
    image?.close?.();
  }
}
