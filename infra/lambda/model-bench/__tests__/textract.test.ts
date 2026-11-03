import { describe, expect, it } from 'vitest';
import { linesOf, textractHint, textractSupports } from '../textract';

describe('linesOf', () => {
  it('LINE の文字だけを返った順に拾う（WORD と PAGE は捨てる）', () => {
    expect(
      linesOf([
        { BlockType: 'PAGE' },
        { BlockType: 'LINE', Text: 'スーパー 横浜店' },
        { BlockType: 'WORD', Text: 'スーパー' },
        { BlockType: 'LINE', Text: '牛乳 ¥198' },
        { BlockType: 'LINE' },
      ]),
    ).toEqual(['スーパー 横浜店', '牛乳 ¥198']);
  });
});

describe('textractHint', () => {
  it('写真ごとに番号を振って囲み、写真を正とする注意を付ける', () => {
    const hint = textractHint([['店', '合計 100'], ['お釣り 0']]);
    expect(hint).toContain('<textract photo="1">\n店\n合計 100\n</textract>');
    expect(hint).toContain('<textract photo="2">\nお釣り 0\n</textract>');
    expect(hint).toContain('写真を正とすること');
  });
});

describe('textractSupports', () => {
  it('同期の API が読めるのは JPEG と PNG だけ', () => {
    expect(textractSupports('image/jpeg')).toBe(true);
    expect(textractSupports('image/png')).toBe(true);
    expect(textractSupports('image/webp')).toBe(false);
  });
});
