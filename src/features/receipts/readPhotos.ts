import { classifyItem, latestUsdRate, type Category, type CategoryRule, type Receipt } from '@kakeibo/core';
import { api } from '../../api/index';
import { judgeReceiptItems } from '../../api/classify';
import { uploadToS3 } from '../../api/remote';
import { todayIso } from '../../lib/month';
import { imageFields, newDraftId, type Draft } from './draft';
import type { ReadingStage } from './ReadingProgress';

/** 読み取りに失敗したとき。届いた写真のキーを持たせ、画面はそれを付けた空の下書きを出す */
export class ReadPhotosError extends Error {
  constructor(
    readonly reason: unknown,
    /** 届いた写真のキー（選んだ順） */
    readonly keys: string[],
  ) {
    super(reason instanceof Error ? reason.message : String(reason));
  }
}

/**
 * 写真を送って読み、下書きにする。送る → 読む（OCR）→ カテゴリを決める（判定）の順。
 * 複数枚は、1 枚に収まらない長いレシートを分けて撮ったもの。まとめて 1 回の OCR に渡し、1 枚として読ませる。
 *
 * `photos` は縮めた後の写真（shrinkPhoto）。段が進むたびに onStage、送った割合が変わるたびに onUploaded を呼ぶ。
 * 失敗したら ReadPhotosError を投げる（届いた分の写真のキーを持つ）。
 */
export async function readPhotos(
  photos: Blob[],
  context: { categories: Category[]; rules: CategoryRule[]; receipts: Receipt[] },
  listeners: { onStage: (stage: ReadingStage) => void; onUploaded: (ratio: number) => void },
): Promise<Draft> {
  listeners.onStage('upload');
  // 送った割合は全部の写真のバイト数で均す。1 枚目だけ 100% になって止まって見えないように
  const sent = photos.map(() => 0);
  const totalBytes = photos.reduce((sum, photo) => sum + photo.size, 0);
  const progress = () =>
    totalBytes > 0
      ? photos.reduce((sum, photo, index) => sum + photo.size * sent[index], 0) / totalBytes
      : sent.reduce((sum, ratio) => sum + ratio, 0) / photos.length;
  // 届いた写真のキー（選んだ順）。途中で落ちても、届いた分はレシートに付けて残す
  const uploaded: (string | undefined)[] = photos.map(() => undefined);
  const uploadedKeys = () => uploaded.filter((key): key is string => key !== undefined);

  try {
    // 1 枚が落ちても、他の写真は送り終えるまで待つ（Promise.all だと届く前に諦めてしまう）
    const results = await Promise.allSettled(
      photos.map(async (photo, index) => {
        const target = await api.requestUpload(photo.type || 'image/jpeg');
        await uploadToS3(target, photo, (ratio) => {
          sent[index] = ratio;
          listeners.onUploaded(progress());
        });
        uploaded[index] = target.key;
      }),
    );
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
    const keys = uploadedKeys();

    listeners.onStage('read');
    // 1 枚なら key で送る。これまでと同じ呼び方にしておく
    const result = await api.analyzeReceipt(keys.length === 1 ? { key: keys[0] } : { keys });

    listeners.onStage('classify');
    // OCR は印字を起こすところまで。どの費目かは判定（Jev）に聞く。
    // 判定が届かなければキーワード表の答えがそのまま残る
    const read = result.items.map((item) => ({ ...item, categoryId: classifyItem(item.name, item.categoryId, item.amount) }));
    const judged = await judgeReceiptItems(read, result.storeName, context.categories, context.rules);
    const warnings = [...(result.warnings ?? []), ...judged.warnings];

    return {
      id: newDraftId(),
      storeName: result.storeName,
      date: result.date || todayIso(),
      total: result.total,
      items: judged.items,
      currency: result.currency ?? 'JPY',
      ...(result.currency === 'USD' ? { exchangeRate: latestUsdRate(context.receipts) } : {}),
      ...imageFields(keys),
      paidWith: result.paymentMethod ?? 'cash',
      ...(result.orderNumber ? { orderNumber: result.orderNumber } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  } catch (cause) {
    throw new ReadPhotosError(cause, uploadedKeys());
  }
}
