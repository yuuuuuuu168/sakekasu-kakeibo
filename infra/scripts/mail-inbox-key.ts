/*
 * 下書き登録 API（Muse）の鍵を発行・失効する。手順は docs/operations.md の「下書き登録の鍵」。
 *
 *   npx tsx scripts/mail-inbox-key.ts issue  --sub <sub> [--current current.json] [--days 90] > next.json
 *   npx tsx scripts/mail-inbox-key.ts revoke --id <鍵の ID> --current current.json > next.json
 *
 * 標準出力には、シークレットにそのまま入れる JSON（`{ "keys": [...] }`）だけを出す。シークレットにはトークンの
 * ハッシュしか入らない。トークンそのものは標準エラーに 1 回だけ出す（Muse の入力フォームに入れる分。ここで控えないと二度と出せない）。
 * `--current` には今のシークレットの値を渡す。期限の切れた鍵はここで一覧から落とす。
 *
 * AWS には触らない。読み書きは人が aws secretsmanager で行う（読み取り専用の verify プロファイルでは読めない）。
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { TOKEN_PREFIX, hashToken, parseKeys, type InboxKey } from '../lambda/mail-inbox/token';

export const DEFAULT_KEY_DAYS = 90;

/** 鍵を 1 つ作る。`token` は Muse に渡す値で、`key` はシークレットに入れる値（トークンのハッシュだけを持つ） */
export function issueKey(sub: string, now: Date, days = DEFAULT_KEY_DAYS): { key: InboxKey; token: string } {
  const stamp = now.toISOString().slice(0, 10).replaceAll('-', '');
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return {
    token,
    key: {
      id: `muse-${stamp}-${randomBytes(2).toString('hex')}`,
      tokenHash: hashToken(token),
      sub,
      expiresAt: new Date(now.getTime() + days * 86_400_000).toISOString(),
    },
  };
}

/** 期限の切れた鍵と、指定した ID の鍵を落とす */
export function keepUsable(keys: InboxKey[], now: Date, revoke?: string): InboxKey[] {
  return keys.filter((key) => Date.parse(key.expiresAt) > now.getTime() && key.id !== revoke);
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function main(args: string[]): void {
  const [command] = args;
  const now = new Date();
  const currentPath = option(args, 'current');
  const current = currentPath ? parseKeys(readFileSync(currentPath, 'utf-8')) : [];

  if (command === 'issue') {
    const sub = option(args, 'sub');
    if (!sub) throw new Error('--sub に共通のユーザープールの sub を渡してください');
    const days = Number(option(args, 'days') ?? DEFAULT_KEY_DAYS);
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('--days は 1〜365 の整数です');
    const { key, token } = issueKey(sub, now, days);
    process.stdout.write(`${JSON.stringify({ keys: [...keepUsable(current, now), key] })}\n`);
    process.stderr.write(
      [
        'Muse の入力フォームに入れるトークン（チャットには貼らない。ここでしか出ない）:',
        `  ${token}`,
        `鍵の名前: ${key.id}（ログに出るのはこちら）`,
        `期限:     ${key.expiresAt}`,
        '',
      ].join('\n'),
    );
    return;
  }

  if (command === 'revoke') {
    const id = option(args, 'id');
    if (!id || !currentPath) throw new Error('--id と --current を渡してください');
    if (!current.some((key) => key.id === id)) throw new Error(`鍵 ${id} は今のシークレットにありません`);
    process.stdout.write(`${JSON.stringify({ keys: keepUsable(current, now, id) })}\n`);
    process.stderr.write(`鍵 ${id} を外しました。put-secret-value で入れた時点で失効します\n`);
    return;
  }

  throw new Error('使い方: mail-inbox-key.ts issue --sub <sub> [--current <file>] | revoke --id <id> --current <file>');
}

if (process.argv[1]?.endsWith('mail-inbox-key.ts')) {
  try {
    main(process.argv.slice(2));
  } catch (cause) {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exit(1);
  }
}
