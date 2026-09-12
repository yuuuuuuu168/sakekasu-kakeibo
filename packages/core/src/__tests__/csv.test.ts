import { describe, expect, it } from 'vitest';
import { decodeStatementBytes, detectDelimiter, parseCsv } from '../statement/csv';

describe('parseCsv', () => {
  it('引用符の中の区切りと改行を保つ', () => {
    const rows = parseCsv('a,"b,c",d\n"1\n2",3,4');
    expect(rows).toEqual([
      ['a', 'b,c', 'd'],
      ['1\n2', '3', '4'],
    ]);
  });

  it('二重引用符をほどく', () => {
    expect(parseCsv('"say ""hi""",2')).toEqual([['say "hi"', '2']]);
  });

  it('CRLF と空行を扱う', () => {
    expect(parseCsv('a,b\r\n\r\nc,d\r\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('タブ区切りも読める', () => {
    expect(parseCsv('a\tb\tc', '\t')).toEqual([['a', 'b', 'c']]);
  });
});

describe('decodeStatementBytes', () => {
  it('Shift_JIS の明細を読む', () => {
    const bytes = new Uint8Array([0x83, 0x5a, 0x83, 0x75, 0x83, 0x93, 0x2c, 0x31, 0x30, 0x30]);
    const decoded = decodeStatementBytes(bytes);
    expect(decoded.encoding).toBe('shift_jis');
    expect(decoded.text).toBe('セブン,100');
  });

  it('UTF-8 は UTF-8 として読み、BOM を落とす', () => {
    const bytes = new TextEncoder().encode('﻿セブン,100');
    const decoded = decodeStatementBytes(bytes);
    expect(decoded.encoding).toBe('utf-8');
    expect(decoded.text).toBe('セブン,100');
  });
});

describe('detectDelimiter', () => {
  it('1 行目に多いほうを選ぶ', () => {
    expect(detectDelimiter('a,b,c\n1,2,3')).toBe(',');
    expect(detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
  });
});
