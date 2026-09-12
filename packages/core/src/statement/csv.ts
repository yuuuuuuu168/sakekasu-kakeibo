/**
 * CSV の読み取り。文字コードの判定と RFC4180 相当の解析。
 * 国内のカード会社は Shift_JIS の CSV をまだ吐くので、UTF-8 決め打ちにはできない。
 */

export type DecodedFile = {
  text: string;
  encoding: 'utf-8' | 'shift_jis';
};

/**
 * UTF-8 として厳密に読めれば UTF-8、読めなければ Shift_JIS とみなす。
 * UTF-8 のバイト列は制約が強く、Shift_JIS の日本語が偶然 UTF-8 として通ることはほぼ無い。
 */
export function decodeStatementBytes(bytes: Uint8Array): DecodedFile {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { text: stripBom(text), encoding: 'utf-8' };
  } catch {
    const text = new TextDecoder('shift_jis').decode(bytes);
    return { text: stripBom(text), encoding: 'shift_jis' };
  }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** カンマとタブのうち、1 行目に多く出るほうを区切りとみなす */
export function detectDelimiter(text: string): ',' | '\t' {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const commas = (firstLine.match(/,/g) ?? []).length;
  const tabs = (firstLine.match(/\t/g) ?? []).length;
  return tabs > commas ? '\t' : ',';
}

/**
 * CSV を二次元配列にする。引用符の中の区切り・改行・二重引用符に対応する。
 * 空行は落とす。列数が揃っていない行はそのまま返し、判断は呼び出し側に任せる。
 */
export function parseCsv(text: string, delimiter: string = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === delimiter) {
      row.push(field);
      field = '';
      continue;
    }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field);
      field = '';
      pushRow(rows, row);
      row = [];
      continue;
    }
    field += char;
  }

  row.push(field);
  pushRow(rows, row);
  return rows;
}

function pushRow(rows: string[][], row: string[]): void {
  if (row.some((cell) => cell.trim() !== '')) {
    rows.push(row.map((cell) => cell.trim()));
  }
}
