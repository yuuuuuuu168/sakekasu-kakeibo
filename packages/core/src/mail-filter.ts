/*
 * Yahoo!メールの中継（infra/lambda/mail-relay）が Muse へ転送するメールの条件。
 * 設定画面で直し、中継の Lambda が同じ規則で当てる。画面と Lambda で 2 回書かないためにここに置く。
 *
 * 差出人のどれかに当たる、または件名がどれかの言葉を含めば転送する。両方とも空なら全部を転送する
 * （使い始めは条件を決めずに全部送り、届いたものを見てから絞るため）。
 */

export type MailRelayFilter = {
  /** 差出人。`@` を含めばアドレスとして完全一致、含まなければドメイン（サブドメインも含む） */
  senders: string[];
  /** 件名に含まれていれば当たる言葉 */
  subjectWords: string[];
};

export const EMPTY_MAIL_RELAY_FILTER: MailRelayFilter = { senders: [], subjectWords: [] };

/** 1 つのリストに並べられる数と、1 つの長さの上限。API の検査も同じ値を使う */
export const MAX_FILTER_ENTRIES = 200;
export const MAX_FILTER_ENTRY_LENGTH = 100;

/** 全角半角と大文字小文字の揺れを吸収する */
function fold(text: string): string {
  return text.normalize('NFKC').toLowerCase();
}

/** 差出人の 1 つをそろえる。前後の空白、先頭の `@`（`@amazon.co.jp` と書いたとき）、`<>` を落とす */
export function normalizeSender(entry: string): string {
  return fold(entry).trim().replace(/^<|>$/g, '').replace(/^@/, '');
}

/** 件名の言葉の 1 つをそろえる */
export function normalizeSubjectWord(entry: string): string {
  return fold(entry).trim();
}

/** 画面の入力（1 行に 1 つ）をリストにする。空行と重なりを落とし、上限で切る */
export function parseFilterLines(text: string, kind: 'sender' | 'subject'): string[] {
  const normalize = kind === 'sender' ? normalizeSender : normalizeSubjectWord;
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const entry = normalize(line).slice(0, MAX_FILTER_ENTRY_LENGTH);
    if (entry === '' || seen.has(entry)) continue;
    seen.add(entry);
    entries.push(entry);
  }
  return entries.slice(0, MAX_FILTER_ENTRIES);
}

export function isFilterEmpty(filter: MailRelayFilter): boolean {
  return filter.senders.length === 0 && filter.subjectWords.length === 0;
}

function senderMatches(entry: string, address: string): boolean {
  const target = normalizeSender(address);
  const wanted = normalizeSender(entry);
  if (wanted === '') return false;
  if (wanted.includes('@')) return target === wanted;
  const domain = target.slice(target.lastIndexOf('@') + 1);
  return domain === wanted || domain.endsWith(`.${wanted}`);
}

export type RelayDecision = 'no-filter' | 'sender' | 'subject' | 'none';

/**
 * このメールを転送するか。`none` のときだけ転送しない。
 * 差出人は複数のことがある（From に並ぶ）ので、どれか 1 つが当たればよい
 */
export function decideRelay(filter: MailRelayFilter, mail: { fromAddresses: string[]; subject: string }): RelayDecision {
  if (isFilterEmpty(filter)) return 'no-filter';
  if (filter.senders.some((entry) => mail.fromAddresses.some((address) => senderMatches(entry, address)))) return 'sender';
  const subject = fold(mail.subject);
  if (filter.subjectWords.some((word) => normalizeSubjectWord(word) !== '' && subject.includes(normalizeSubjectWord(word)))) {
    return 'subject';
  }
  return 'none';
}
