import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { PHOTO_JPEG_QUALITY, PHOTO_MAX_LONG_EDGE, PHOTO_MAX_PIXELS, shrinkPhoto, targetSize, type PhotoCodec } from '../shrinkPhoto';

describe('targetSize', () => {
  it('12MP のスマホの写真（4:3）は画素数の上限で縮める', () => {
    const size = targetSize(4032, 3024);
    expect(size.width * size.height).toBeLessThanOrEqual(PHOTO_MAX_PIXELS);
    expect(size.width / size.height).toBeCloseTo(4032 / 3024, 2);
  });

  it('縦に長いレシートの写真は長辺の上限で縮める', () => {
    expect(targetSize(1000, 5000)).toEqual({ width: 515, height: PHOTO_MAX_LONG_EDGE });
  });

  it('上限より小さい写真は大きくしない', () => {
    expect(targetSize(1200, 1600)).toEqual({ width: 1200, height: 1600 });
  });

  it('どんな大きさでも、長辺と画素数の上限に収まり、縦横比を保つ', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 12000 }), fc.integer({ min: 1, max: 12000 }), (width, height) => {
        const size = targetSize(width, height);
        expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(PHOTO_MAX_LONG_EDGE);
        expect(size.width * size.height).toBeLessThanOrEqual(PHOTO_MAX_PIXELS);
        expect(size.width).toBeLessThanOrEqual(width);
        expect(size.height).toBeLessThanOrEqual(height);
        expect(size.width).toBeGreaterThanOrEqual(1);
        expect(size.height).toBeGreaterThanOrEqual(1);
      }),
    );
  });
});

describe('shrinkPhoto', () => {
  const file = new File([new Uint8Array(10)], 'receipt.png', { type: 'image/png' });

  it('縮めた大きさで JPEG に書き出し、読み込んだ画像を閉じる', async () => {
    const close = vi.fn();
    const jpeg = new Blob(['x'], { type: 'image/jpeg' });
    const codec: PhotoCodec = {
      decode: async () => ({ width: 4032, height: 3024, close }),
      encode: vi.fn(async () => jpeg),
    };

    await expect(shrinkPhoto(file, codec)).resolves.toBe(jpeg);
    expect(codec.encode).toHaveBeenCalledWith(expect.anything(), targetSize(4032, 3024), PHOTO_JPEG_QUALITY);
    expect(close).toHaveBeenCalled();
  });

  it('縮める必要が無く、書き直すとかえって大きくなるなら、読める形式の元のファイルを返す', async () => {
    const small = new File([new Uint8Array(10)], 'screenshot.webp', { type: 'image/webp' });
    const codec: PhotoCodec = {
      decode: async () => ({ width: 1200, height: 1600 }),
      encode: async () => new Blob([new Uint8Array(20)], { type: 'image/jpeg' }),
    };
    await expect(shrinkPhoto(small, codec)).resolves.toBe(small);
  });

  it('縮める必要が無くても、読めない形式（HEIC）は JPEG にしたものを返す', async () => {
    const heic = new File([new Uint8Array(10)], 'IMG.heic', { type: 'image/heic' });
    const jpeg = new Blob([new Uint8Array(20)], { type: 'image/jpeg' });
    const codec: PhotoCodec = { decode: async () => ({ width: 1200, height: 1600 }), encode: async () => jpeg };
    await expect(shrinkPhoto(heic, codec)).resolves.toBe(jpeg);
  });

  it('読めない形式なら元のファイルをそのまま返す', async () => {
    const codec: PhotoCodec = {
      decode: async () => {
        throw new Error('The source image could not be decoded.');
      },
      encode: vi.fn(),
    };
    await expect(shrinkPhoto(file, codec)).resolves.toBe(file);
    expect(codec.encode).not.toHaveBeenCalled();
  });

  it('書き出しに失敗しても元のファイルを返す', async () => {
    const close = vi.fn();
    const codec: PhotoCodec = {
      decode: async () => ({ width: 100, height: 100, close }),
      encode: async () => {
        throw new Error('canvas が使えません');
      },
    };
    await expect(shrinkPhoto(file, codec)).resolves.toBe(file);
    expect(close).toHaveBeenCalled();
  });

  it('createImageBitmap の無い環境（テストの jsdom など）でも元のファイルを返す', async () => {
    await expect(shrinkPhoto(file)).resolves.toBe(file);
  });
});
