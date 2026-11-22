import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Message = { uid: number; source: string; internalDate?: Date };

const state = vi.hoisted(() => ({
  secret: undefined as string | undefined,
  stored: undefined as Record<string, unknown> | undefined,
  saved: [] as Record<string, unknown>[],
  sent: [] as Buffer[],
  sendFails: false,
  authFails: false,
  uidValidity: 7n,
  /** 受信箱のメール */
  messages: [] as { uid: number; source: string; internalDate?: Date }[],
  /** 受信箱のほかのフォルダ（パス → UIDVALIDITY とメール） */
  folders: {} as Record<string, { uidValidity: bigint; messages: { uid: number; source: string; internalDate?: Date }[]; specialUse?: string }>,
  opened: [] as string[],
  lockOptions: [] as unknown[],
  fetchOneQueries: [] as unknown[],
  filter: undefined as Record<string, unknown> | undefined,
  filterKeys: [] as unknown[],
  filterProjections: [] as unknown[],
}));

vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class {
    async send() {
      return { SecretString: state.secret };
    }
  },
  GetSecretValueCommand: class {},
}));

vi.mock('@aws-sdk/client-sesv2', () => ({
  SESv2Client: class {
    async send(command: { input: { Content: { Raw: { Data: Buffer } } } }) {
      if (state.sendFails) throw Object.assign(new Error('Email address is not verified'), { name: 'MessageRejected' });
      state.sent.push(command.input.Content.Raw.Data);
      return {};
    }
  },
  SendEmailCommand: class {
    constructor(readonly input: unknown) {}
  },
}));

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: () => ({
      async send(command: { kind: string; input: { Item?: Record<string, unknown>; Key?: { pk: string; sk: string } } }) {
        if (command.kind === 'get' && command.input.Key?.sk === 'CONFIG#mailRelayFilter') {
          state.filterKeys.push(command.input.Key);
          state.filterProjections.push((command.input as { ProjectionExpression?: string }).ProjectionExpression);
          return { Item: state.filter ? { mailRelayFilter: state.filter } : undefined };
        }
        if (command.kind === 'get') return { Item: state.stored };
        state.stored = command.input.Item;
        state.saved.push(command.input.Item!);
        return {};
      },
    }),
  },
  GetCommand: class {
    kind = 'get';
    constructor(readonly input: unknown) {}
  },
  PutCommand: class {
    kind = 'put';
    constructor(readonly input: unknown) {}
  },
}));

vi.mock('imapflow', () => ({
  ImapFlow: class {
    mailbox: unknown;
    constructor(readonly options: { logger: unknown }) {}
    async connect() {
      if (state.authFails) throw Object.assign(new Error('Invalid credentials'), { authenticationFailed: true });
    }
    current = 'INBOX';
    box() {
      return this.current === 'INBOX' ? { uidValidity: state.uidValidity, messages: state.messages } : state.folders[this.current];
    }
    async list() {
      return [
        { path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox', flags: new Set<string>() },
        ...Object.entries(state.folders).map(([path, folder]) => ({ path, name: path, specialUse: folder.specialUse, flags: new Set<string>() })),
      ];
    }
    async getMailboxLock(path: string, options: unknown) {
      state.lockOptions.push(options);
      state.opened.push(path);
      this.current = path;
      const box = this.box();
      const uidNext = Math.max(0, ...box.messages.map((message) => message.uid)) + 1;
      this.mailbox = { uidValidity: box.uidValidity, uidNext };
      return { release() {} };
    }
    async *fetch(range: string) {
      const messages = this.box().messages;
      const from = Number(range.split(':')[0]);
      const matched = messages.filter((message) => message.uid >= from);
      // `N:*` は該当が無くても最後の 1 通を返す（IMAP の決まり）
      const list = matched.length > 0 ? matched : messages.slice(-1);
      for (const message of list) {
        const from = /From: (.*)/.exec(message.source)?.[1] ?? '';
        const subject = /Subject: (.*)/.exec(message.source)?.[1] ?? '';
        yield {
          uid: message.uid,
          size: message.source.length,
          internalDate: message.internalDate ?? new Date(),
          envelope: { from: [{ address: from }], subject },
        };
      }
    }
    async fetchOne(uid: string, query: unknown) {
      state.fetchOneQueries.push(query);
      const message = this.box().messages.find((candidate) => candidate.uid === Number(uid));
      return message ? { uid: message.uid, source: Buffer.from(message.source) } : false;
    }
    async logout() {}
  },
}));

let handler: (event: unknown) => Promise<void>;

beforeAll(async () => {
  process.env.TABLE_NAME = 'table';
  process.env.MAIL_RELAY_SECRET_ID = 'arn:test';
  process.env.MAIL_RELAY_FROM = 'Yahoo!メールの転送 <relay@kakeibo.example.com>';
  ({ handler } = await import('../index'));
});

const mail = (uid: number, from = `shop${uid}@example.com`, subject = `order ${uid}`): Message => ({
  uid,
  source: [`From: ${from}`, 'To: me@yahoo.co.jp', `Subject: ${subject}`, `Message-ID: <m${uid}@example.com>`, '', `body ${uid}`, ''].join('\r\n'),
});

beforeEach(() => {
  state.secret = JSON.stringify({ user: 'me', password: 'pw', forwardTo: 'muse@example.com' });
  state.stored = undefined;
  state.saved = [];
  state.sent = [];
  state.sendFails = false;
  state.authFails = false;
  state.uidValidity = 7n;
  state.messages = [mail(10), mail(11)];
  state.folders = {};
  state.opened = [];
  state.lockOptions = [];
  state.fetchOneQueries = [];
  state.filter = undefined;
  state.filterKeys = [];
  state.filterProjections = [];
  for (const method of ['info', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation(() => {});
});

/** 保存した行の、あるフォルダの最後の UID */
const lastUidOf = (item: Record<string, unknown> | undefined, path = 'INBOX') =>
  (item?.folders as Record<string, { lastUid: number }> | undefined)?.[path]?.lastUid;

const logged = (method: 'info' | 'warn' | 'error') => vi.mocked(console[method]).mock.calls.map((call) => call.join(' ')).join('\n');

describe('mail-relay', () => {
  it('設定が無ければ何もしない', async () => {
    state.secret = 'random-initial-value';
    await handler({});
    expect(state.saved).toHaveLength(0);
    expect(state.sent).toHaveLength(0);
  });

  it('初回は最新を基準にするだけで、過去のメールは送らない', async () => {
    await handler({});
    expect(state.sent).toHaveLength(0);
    expect(state.stored).toMatchObject({ folders: { INBOX: { uidValidity: '7', lastUid: 11 } }, authFailures: 0 });
  });

  it('続きからは新着だけを古い順に送り、1 通ごとに進み具合を書く', async () => {
    state.stored = { uidValidity: '7', lastUid: 11, authFailures: 0 };
    state.messages.push(mail(12), mail(13));
    await handler({});
    expect(state.sent.map((raw) => /Subject: (.*)/.exec(raw.toString())?.[1])).toEqual(['Fwd: order 12', 'Fwd: order 13']);
    expect(state.saved.map((item) => lastUidOf(item))).toEqual([12, 13]);
    // 受信箱は読み取り専用で開く（既読にしない）
    expect(state.lockOptions).toEqual([{ readOnly: true }]);
  });

  it('新着が無ければ何も送らない（`N:*` が返す最後の 1 通を送り直さない）', async () => {
    state.stored = { uidValidity: '7', lastUid: 11, authFailures: 0 };
    await handler({});
    expect(state.sent).toHaveLength(0);
  });

  it('送れなかったら進み具合を進めず、次の回で同じメールから送り直す', async () => {
    state.stored = { uidValidity: '7', lastUid: 11, authFailures: 0 };
    state.messages.push(mail(12));
    state.sendFails = true;
    await handler({});
    expect(state.saved).toHaveLength(0);
    expect(logged('error')).toContain('[mail-relay] failed');
    expect(logged('error')).toContain('MessageRejected');
    state.sendFails = false;
    await handler({});
    expect(state.saved.map((item) => lastUidOf(item))).toEqual([12]);
  });

  it('UIDVALIDITY が変わったら数え直し、取りこぼしの可能性を知らせる', async () => {
    state.stored = { uidValidity: '6', lastUid: 500, authFailures: 0 };
    await handler({});
    expect(state.sent).toHaveLength(0);
    expect(state.stored).toMatchObject({ folders: { INBOX: { uidValidity: '7', lastUid: 11 } } });
    expect(logged('warn')).toContain('[mail-relay] uid-reset');
  });

  it('認証の失敗を数え、2 回続いたら知らせ、3 回続いたら間隔を空ける', async () => {
    state.authFails = true;
    await handler({});
    expect(state.stored).toMatchObject({ authFailures: 1 });
    expect(logged('warn')).not.toContain('auth-failing');
    await handler({});
    await handler({});
    expect(state.stored).toMatchObject({ authFailures: 3 });
    expect(logged('warn')).toContain('[mail-relay] auth-failing');

    // 3 回続いた直後は試さない（Yahoo! に止められないように）
    const before = state.saved.length;
    await handler({});
    expect(state.saved).toHaveLength(before);

    // 1 時間たって通れば 0 に戻る
    state.stored = { ...state.stored, lastAuthFailureAt: '2000-01-01T00:00:00Z', uidValidity: '7', lastUid: 11 };
    state.authFails = false;
    await handler({});
    expect(state.stored).toMatchObject({ authFailures: 0 });
  });

  it('条件があれば、差出人か件名のどちらかに当たったメールだけを送り、当たらないものは本文を取りに行かずに進める', async () => {
    state.secret = JSON.stringify({ user: 'me', password: 'pw', forwardTo: 'muse@example.com', sub: 'sub-1' });
    state.filter = { senders: ['amazon.co.jp'], subjectWords: ['領収'] };
    state.stored = { uidValidity: '7', lastUid: 11, authFailures: 0 };
    state.messages.push(
      mail(12, 'auto-confirm@amazon.co.jp', 'ご注文の確認'),
      mail(13, 'friend@example.com', '週末の予定'),
      mail(14, 'shop@unknown.example', '領収書の送付'),
    );
    await handler({});
    expect(state.filterKeys).toEqual([{ pk: 'USER#sub-1', sk: 'CONFIG#mailRelayFilter' }]);
    // 権限は mailRelayFilter の項目しか読めない。項目を指定して読む
    expect(state.filterProjections).toEqual(['mailRelayFilter']);
    expect(state.sent.map((raw) => /Subject: (.*)/.exec(raw.toString())?.[1])).toHaveLength(2);
    expect(state.fetchOneQueries).toHaveLength(2);
    // 送らなかった 13 も処理済みとして進む
    expect(state.saved.map((item) => lastUidOf(item))).toEqual([12, 13, 14]);
    expect(logged('info')).toContain('"条件に当たらず":1');
  });

  it('シークレットに sub が無ければ、条件を読まずに全部を送る', async () => {
    state.stored = { uidValidity: '7', lastUid: 11, authFailures: 0 };
    state.filter = { senders: ['amazon.co.jp'], subjectWords: [] };
    state.messages.push(mail(12, 'friend@example.com', 'hello'));
    await handler({});
    expect(state.filterKeys).toHaveLength(0);
    expect(state.sent).toHaveLength(1);
  });

  it('受信箱しか見ていなかった頃の進み具合を、受信箱のものとして引き継ぐ', async () => {
    state.stored = { uidValidity: '7', lastUid: 11, authFailures: 0 };
    state.messages.push(mail(12));
    await handler({});
    expect(state.sent).toHaveLength(1);
    expect(state.stored).toMatchObject({ folders: { INBOX: { uidValidity: '7', lastUid: 12 } } });
    expect(state.stored).not.toHaveProperty('lastUid');
  });

  it('個人フォルダも見る。初めて見るフォルダは基準を決めるだけで、その後に届いた分を送る', async () => {
    state.stored = { folders: { INBOX: { uidValidity: '7', lastUid: 11 } }, authFailures: 0 };
    state.folders = { 買い物: { uidValidity: 3n, messages: [mail(1, 'a@shop.example', 'old order')] } };
    await handler({});
    expect(state.sent).toHaveLength(0);
    expect(lastUidOf(state.stored, '買い物')).toBe(1);
    expect(logged('info')).toContain('"フォルダ":"買い物"');

    state.folders.買い物.messages.push(mail(2, 'a@shop.example', 'new order'));
    await handler({});
    expect(state.sent.map((raw) => /Subject: (.*)/.exec(raw.toString())?.[1])).toEqual(['Fwd: new order']);
    expect(lastUidOf(state.stored, '買い物')).toBe(2);
  });

  it('迷惑メール・ゴミ箱・送信済み・下書きのフォルダは開かない', async () => {
    state.stored = { folders: { INBOX: { uidValidity: '7', lastUid: 11 } }, authFailures: 0 };
    state.folders = {
      'Bulk Mail': { uidValidity: 1n, messages: [mail(1)] },
      Trash: { uidValidity: 1n, messages: [mail(1)], specialUse: '\\Trash' },
      個人: { uidValidity: 1n, messages: [mail(1)] },
    };
    await handler({});
    expect(state.opened).toEqual(['INBOX', '個人']);
  });

  it('届いてから 1 日より古いメール（手で移した古いメールなど）は送らずに進める', async () => {
    state.stored = { folders: { INBOX: { uidValidity: '7', lastUid: 11 } }, authFailures: 0 };
    state.messages.push({ ...mail(12), internalDate: new Date(Date.now() - 2 * 86_400_000) }, mail(13));
    await handler({});
    expect(state.sent.map((raw) => /Subject: (.*)/.exec(raw.toString())?.[1])).toEqual(['Fwd: order 13']);
    expect(state.fetchOneQueries).toHaveLength(1);
    expect(lastUidOf(state.stored)).toBe(13);
    expect(logged('info')).toContain('"古いので送らず":1');
  });

  it('消したフォルダの進み具合は落とす', async () => {
    state.stored = { folders: { INBOX: { uidValidity: '7', lastUid: 11 }, 消した: { uidValidity: '1', lastUid: 9 } }, authFailures: 0 };
    await handler({});
    expect(state.stored?.folders).toEqual({ INBOX: { uidValidity: '7', lastUid: 11 } });
  });

  it('1 回に送る上限はフォルダをまたいで数える', async () => {
    state.stored = { folders: { INBOX: { uidValidity: '7', lastUid: 11 }, 個人: { uidValidity: '1', lastUid: 0 } }, authFailures: 0 };
    state.messages.push(...Array.from({ length: 45 }, (_, index) => mail(12 + index)));
    state.folders = { 個人: { uidValidity: 1n, messages: Array.from({ length: 10 }, (_, index) => mail(1 + index)) } };
    await handler({});
    expect(state.sent).toHaveLength(50);
    expect(lastUidOf(state.stored, '個人')).toBe(5);
    expect(logged('info')).toContain('"残り":5');
  });

  it('ログに件名・差出人・本文を出さない', async () => {
    state.stored = { uidValidity: '7', lastUid: 11, authFailures: 0 };
    state.messages.push(mail(12));
    await handler({});
    const all = [logged('info'), logged('warn'), logged('error')].join('\n');
    expect(all).not.toContain('order 12');
    expect(all).not.toContain('shop12@example.com');
    expect(all).not.toContain('body 12');
    expect(all).toContain('"UID":12');
    expect(all).toContain('"フォルダ":"INBOX"');
  });
});
