import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Message = { uid: number; source: string };

const state = vi.hoisted(() => ({
  secret: undefined as string | undefined,
  stored: undefined as Record<string, unknown> | undefined,
  saved: [] as Record<string, unknown>[],
  sent: [] as Buffer[],
  sendFails: false,
  authFails: false,
  uidValidity: 7n,
  messages: [] as { uid: number; source: string }[],
  lockOptions: [] as unknown[],
  fetchOneQueries: [] as unknown[],
  filter: undefined as Record<string, unknown> | undefined,
  filterKeys: [] as unknown[],
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
    async getMailboxLock(_path: string, options: unknown) {
      state.lockOptions.push(options);
      const uidNext = Math.max(0, ...state.messages.map((message) => message.uid)) + 1;
      this.mailbox = { uidValidity: state.uidValidity, uidNext };
      return { release() {} };
    }
    async *fetch(range: string) {
      const from = Number(range.split(':')[0]);
      const matched = state.messages.filter((message) => message.uid >= from);
      // `N:*` は該当が無くても最後の 1 通を返す（IMAP の決まり）
      const list = matched.length > 0 ? matched : state.messages.slice(-1);
      for (const message of list) {
        const from = /From: (.*)/.exec(message.source)?.[1] ?? '';
        const subject = /Subject: (.*)/.exec(message.source)?.[1] ?? '';
        yield { uid: message.uid, size: message.source.length, envelope: { from: [{ address: from }], subject } };
      }
    }
    async fetchOne(uid: string, query: unknown) {
      state.fetchOneQueries.push(query);
      const message = state.messages.find((candidate) => candidate.uid === Number(uid));
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
  state.lockOptions = [];
  state.fetchOneQueries = [];
  state.filter = undefined;
  state.filterKeys = [];
  for (const method of ['info', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation(() => {});
});

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
    expect(state.stored).toMatchObject({ uidValidity: '7', lastUid: 11, authFailures: 0 });
  });

  it('続きからは新着だけを古い順に送り、1 通ごとに進み具合を書く', async () => {
    state.stored = { uidValidity: '7', lastUid: 11, authFailures: 0 };
    state.messages.push(mail(12), mail(13));
    await handler({});
    expect(state.sent.map((raw) => /Subject: (.*)/.exec(raw.toString())?.[1])).toEqual(['Fwd: order 12', 'Fwd: order 13']);
    expect(state.saved.map((item) => item.lastUid)).toEqual([12, 13]);
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
    expect(state.saved.map((item) => item.lastUid)).toEqual([12]);
  });

  it('UIDVALIDITY が変わったら数え直し、取りこぼしの可能性を知らせる', async () => {
    state.stored = { uidValidity: '6', lastUid: 500, authFailures: 0 };
    await handler({});
    expect(state.sent).toHaveLength(0);
    expect(state.stored).toMatchObject({ uidValidity: '7', lastUid: 11 });
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
    expect(state.sent.map((raw) => /Subject: (.*)/.exec(raw.toString())?.[1])).toHaveLength(2);
    expect(state.fetchOneQueries).toHaveLength(2);
    // 送らなかった 13 も処理済みとして進む
    expect(state.saved.map((item) => item.lastUid)).toEqual([12, 13, 14]);
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

  it('ログに件名・差出人・本文を出さない', async () => {
    state.stored = { uidValidity: '7', lastUid: 11, authFailures: 0 };
    state.messages.push(mail(12));
    await handler({});
    const all = [logged('info'), logged('warn'), logged('error')].join('\n');
    expect(all).not.toContain('order 12');
    expect(all).not.toContain('shop12@example.com');
    expect(all).not.toContain('body 12');
    expect(all).toContain('"UID":12');
  });
});
