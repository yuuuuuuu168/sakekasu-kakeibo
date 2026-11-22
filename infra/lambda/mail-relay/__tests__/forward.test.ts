import { describe, expect, it } from 'vitest';
import { simpleParser } from 'mailparser';
import { MAX_ATTACHMENT_BYTES, buildForward, buildOversizeNotice } from '../forward';

const target = { from: 'Yahoo!メールの転送 <relay@kakeibo.example.com>', to: 'muse@example.com' };

function original(attachment?: { name: string; bytes: number }): string {
  const lines = [
    'From: =?UTF-8?B?QW1hem9uLmNvLmpw?= <auto-confirm@amazon.co.jp>',
    'To: me@yahoo.co.jp',
    'Subject: =?UTF-8?B?44GU5rOo5paH44Gu56K66KqN?=',
    'Date: Sun, 22 Nov 2026 13:05:00 +0900',
    'Message-ID: <order-123@amazon.co.jp>',
    'MIME-Version: 1.0',
  ];
  if (!attachment) {
    return [...lines, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit', '', '注文番号 250-1234567-1234567 合計 ¥1,398', ''].join('\r\n');
  }
  const content = Buffer.alloc(attachment.bytes, 0x41).toString('base64').replace(/.{76}/g, '$&\r\n');
  return [
    ...lines,
    'Content-Type: multipart/mixed; boundary="b"',
    '',
    '--b',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    '領収書を添付します',
    '--b',
    `Content-Type: application/pdf; name="${attachment.name}"`,
    `Content-Disposition: attachment; filename="${attachment.name}"`,
    'Content-Transfer-Encoding: base64',
    '',
    content,
    '--b--',
    '',
  ].join('\r\n');
}

describe('buildForward', () => {
  it('家計簿のドメインから送り、本文の頭に元の差出人・件名・Message-ID を書く', async () => {
    const { raw } = await buildForward(await simpleParser(original()), target);
    const sent = await simpleParser(raw);
    expect(sent.from?.text).toContain('relay@kakeibo.example.com');
    expect(sent.to && !Array.isArray(sent.to) ? sent.to.text : '').toBe('muse@example.com');
    expect(sent.subject).toBe('Fwd: ご注文の確認');
    expect(sent.text).toContain('差出人: "Amazon.co.jp" <auto-confirm@amazon.co.jp>');
    expect(sent.text).toContain('件名: ご注文の確認');
    expect(sent.text).toContain('日付: 2026-11-22 13:05（日本時間）');
    expect(sent.text).toContain('Message-ID: <order-123@amazon.co.jp>');
    expect(sent.text).toContain('注文番号 250-1234567-1234567 合計 ¥1,398');
    expect(sent.headers.get('x-original-message-id')).toBe('<order-123@amazon.co.jp>');
    // 転送したメール自身の Message-ID は元のものと別になる。Muse には本文の行を使ってもらう
    expect(sent.messageId).not.toBe('<order-123@amazon.co.jp>');
  });

  it('上限までの添付はそのまま付ける', async () => {
    const { raw, attachments, dropped } = await buildForward(await simpleParser(original({ name: 'receipt.pdf', bytes: 2048 })), target);
    expect([attachments, dropped]).toEqual([1, []]);
    const sent = await simpleParser(raw);
    expect(sent.attachments.map((attachment) => [attachment.filename, attachment.size])).toEqual([['receipt.pdf', 2048]]);
  });

  it('上限を超えた添付は外し、外したもののファイル名と大きさを本文に書く', async () => {
    const parsed = await simpleParser(original({ name: 'big.pdf', bytes: MAX_ATTACHMENT_BYTES + 1 }));
    const { raw, attachments, dropped } = await buildForward(parsed, target);
    expect(attachments).toBe(0);
    expect(dropped).toEqual([{ filename: 'big.pdf', size: MAX_ATTACHMENT_BYTES + 1 }]);
    const sent = await simpleParser(raw);
    expect(sent.attachments).toHaveLength(0);
    expect(sent.text).toContain('big.pdf（10.0MB）');
    expect(sent.text).toContain('領収書を添付します');
  });

  it('HTML の本文では、頭に書く元の情報を HTML として逃がす', async () => {
    const html = original().replace('text/plain', 'text/html').replace('注文番号', '<b>注文番号</b>');
    const sent = await simpleParser((await buildForward(await simpleParser(html), target)).raw);
    expect(sent.html).toContain('&#60;auto-confirm@amazon.co.jp&#62;');
    expect(sent.html).toContain('<b>注文番号</b>');
  });
});

it('大きすぎるメールは、宛名の情報と「転送していない」旨だけを送る', async () => {
  const raw = await buildOversizeNotice(
    { from: 'shop <a@shop.example>', to: 'me@yahoo.co.jp', date: new Date('2026-11-22T04:05:00Z'), subject: '大きな添付', messageId: '<m@x>' },
    40 * 1024 * 1024,
    target,
  );
  const sent = await simpleParser(raw);
  expect(sent.subject).toBe('Fwd: 大きな添付');
  expect(sent.text).toContain('40.0MB');
  expect(sent.text).toContain('Message-ID: <m@x>');
});
