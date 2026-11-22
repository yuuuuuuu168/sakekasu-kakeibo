import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  EMPTY_MAIL_RELAY_FILTER,
  MAX_FILTER_ENTRIES,
  MAX_FILTER_ENTRY_LENGTH,
  decideRelay,
  parseFilterLines,
  type MailRelayFilter,
} from '../mail-filter';

const mail = (from: string, subject: string) => ({ fromAddresses: [from], subject });

describe('decideRelay', () => {
  const filter: MailRelayFilter = { senders: ['amazon.co.jp', 'order@shop.example'], subjectWords: ['領収', '注文'] };

  it('条件が空なら全部を転送する', () => {
    expect(decideRelay(EMPTY_MAIL_RELAY_FILTER, mail('friend@example.com', 'hello'))).toBe('no-filter');
  });

  it('差出人か件名のどちらかに当たれば転送する', () => {
    expect(decideRelay(filter, mail('auto-confirm@amazon.co.jp', 'セールのお知らせ'))).toBe('sender');
    expect(decideRelay(filter, mail('shop@unknown.example', '領収書の送付'))).toBe('subject');
    expect(decideRelay(filter, mail('auto-confirm@amazon.co.jp', 'ご注文の確認'))).toBe('sender');
  });

  it('どちらにも当たらなければ転送しない', () => {
    expect(decideRelay(filter, mail('friend@example.com', '週末の予定'))).toBe('none');
  });

  it('ドメインはサブドメインにも当たるが、名前の一部だけ同じドメインには当たらない', () => {
    expect(decideRelay(filter, mail('ship@mail.amazon.co.jp', 'x'))).toBe('sender');
    expect(decideRelay(filter, mail('x@notamazon.co.jp', 'x'))).toBe('none');
    expect(decideRelay(filter, mail('x@amazon.co.jp.evil.example', 'x'))).toBe('none');
  });

  it('アドレスで書いた差出人は、そのアドレスだけに当たる', () => {
    expect(decideRelay(filter, mail('order@shop.example', 'x'))).toBe('sender');
    expect(decideRelay(filter, mail('info@shop.example', 'x'))).toBe('none');
  });

  it('大文字小文字と全角半角の揺れを吸収する', () => {
    expect(decideRelay(filter, mail('Auto-Confirm@AMAZON.CO.JP', 'x'))).toBe('sender');
    expect(decideRelay({ senders: [], subjectWords: ['receipt'] }, mail('a@b.example', 'Your ＲＥＣＥＩＰＴ'))).toBe('subject');
  });

  it('差出人が複数並んでいれば、どれか 1 つが当たればよい', () => {
    expect(decideRelay(filter, { fromAddresses: ['a@b.example', 'x@amazon.co.jp'], subject: '' })).toBe('sender');
  });

  it('どんな差出人・件名でも、条件が空なら必ず転送する', () => {
    fc.assert(
      fc.property(fc.array(fc.string()), fc.string(), (fromAddresses, subject) => {
        expect(decideRelay(EMPTY_MAIL_RELAY_FILTER, { fromAddresses, subject })).not.toBe('none');
      }),
    );
  });

  it('条件を足しても、それまで転送していたメールは転送したまま（条件は広げる方向にしか効かない）', () => {
    const entry = fc.stringMatching(/^[a-z0-9.@-]{1,12}$/);
    fc.assert(
      fc.property(fc.array(entry, { minLength: 1 }), fc.array(entry), entry, fc.string(), (senders, words, extra, subject) => {
        const before: MailRelayFilter = { senders, subjectWords: words };
        const after: MailRelayFilter = { senders: [...senders, extra], subjectWords: words };
        const target = { fromAddresses: [`x@${senders[0]}`], subject };
        if (decideRelay(before, target) !== 'none') expect(decideRelay(after, target)).not.toBe('none');
      }),
    );
  });
});

describe('parseFilterLines', () => {
  it('1 行に 1 つを読み、空行と重なりを落とし、差出人の先頭の @ と <> を外す', () => {
    expect(parseFilterLines(' @Amazon.co.jp \n\n<order@shop.example>\namazon.co.jp\r\n', 'sender')).toEqual([
      'amazon.co.jp',
      'order@shop.example',
    ]);
    expect(parseFilterLines('領収\n 注文 \n領収', 'subject')).toEqual(['領収', '注文']);
  });

  it('数と長さの上限で切る', () => {
    const many = Array.from({ length: MAX_FILTER_ENTRIES + 5 }, (_, index) => `w${index}`).join('\n');
    expect(parseFilterLines(many, 'subject')).toHaveLength(MAX_FILTER_ENTRIES);
    expect(parseFilterLines('a'.repeat(MAX_FILTER_ENTRY_LENGTH + 10), 'subject')[0]).toHaveLength(MAX_FILTER_ENTRY_LENGTH);
  });
});
