/**
 * 旧ユーザープールの sub から共通ログインの sub へ、データのキーを付け替える規則。
 *
 * AWS を呼ばない純粋関数だけを置く（テストは __tests__/plan.test.ts）。
 * 実際の読み書きは index.ts が行う。
 *
 * sub が入っている場所はコードから調べて次の 3 つだけ（2026-10 時点）。
 *
 * 1. DynamoDB の pk。`USER#<sub>`。sk（TXN# / CONFIG# / BUDGET# / MAPPING# / RECEIPT# / REPORT#）には
 *    sub は入らない。テーブルに GSI / LSI は無い（infra/lib/data-stack.ts）
 * 2. レシートの項目（sk が RECEIPT#）の imageKey。`receipts/<sub>/<日付>/<uuid>.<拡張子>`
 *    （infra/lambda/api/index.ts の createUpload が作る）
 * 3. S3 のレシート画像のキー。2 と同じ形
 *
 * 新しく sub を持つ場所を足したら、ここにも足す。見落としに気づけるよう、付け替えた後の
 * 項目に旧 sub が残っていないかを leftovers で返し、index.ts が警告に出す。
 */

/** Cognito の sub は UUID。取り違え（ユーザー名やメールを渡すなど）をここで止める */
const SUB = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function assertSubs(from: string, to: string): void {
  if (!SUB.test(from)) throw new Error(`--from が sub（UUID）の形ではありません: ${from}`);
  if (!SUB.test(to)) throw new Error(`--to が sub（UUID）の形ではありません: ${to}`);
  if (from === to) throw new Error('--from と --to が同じです');
}

export function userPk(sub: string): string {
  return `USER#${sub}`;
}

export function receiptPrefix(sub: string): string {
  return `receipts/${sub}/`;
}

/** レシート画像のキーを付け替える。旧 sub の下でなければ undefined（付け替えない） */
export function rewriteObjectKey(key: string, from: string, to: string): string | undefined {
  const prefix = receiptPrefix(from);
  if (!key.startsWith(prefix)) return undefined;
  return receiptPrefix(to) + key.slice(prefix.length);
}

export type Item = Record<string, unknown>;

export type RewrittenItem = {
  item: Item;
  /** 付け替えた後も旧 sub を含んでいる値の場所（例: `items[0].note`）。空なら漏れは無い */
  leftovers: string[];
};

/**
 * DynamoDB の項目 1 つを新しい sub の項目に直す。元の項目は変えない。
 *
 * pk は必ず付け替える。imageKey は旧 sub の下を指しているときだけ付け替える
 * （画像は index.ts が同じ規則で新しいキーへコピーする）。ほかの値はそのまま写す。
 */
export function rewriteItem(source: Item, from: string, to: string): RewrittenItem {
  if (source.pk !== userPk(from)) {
    throw new Error(`pk が ${userPk(from)} ではない項目は扱えません: ${String(source.pk)}`);
  }

  const item: Item = { ...source, pk: userPk(to) };
  if (typeof source.imageKey === 'string') {
    const rewritten = rewriteObjectKey(source.imageKey, from, to);
    if (rewritten !== undefined) item.imageKey = rewritten;
  }

  return { item, leftovers: findString(item, from) };
}

/** 値の中で needle を含む文字列（キー名も見る）の場所を並べる */
export function findString(value: unknown, needle: string, path = ''): string[] {
  if (typeof value === 'string') return value.includes(needle) ? [path || '(値)'] : [];
  if (Array.isArray(value)) return value.flatMap((entry, index) => findString(entry, needle, `${path}[${index}]`));
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, entry]) => {
      const here = path ? `${path}.${key}` : key;
      return [...(key.includes(needle) ? [`${here}（キー名）`] : []), ...findString(entry, needle, here)];
    });
  }
  return [];
}

export type Options = {
  table: string;
  bucket?: string;
  from: string;
  to: string;
  region: string;
  apply: boolean;
};

export const USAGE = `使い方:
  npx tsx scripts/copy-user-data/index.ts \\
    --table <テーブル名> --bucket <レシート用バケット名> \\
    --from <旧ユーザープールの sub> --to <共通ログインの sub> [--apply] [--region ap-northeast-1]

  既定は dry-run（読むだけ。件数と例を出す）。--apply を付けたときだけ書き込む。
  レシート画像を扱わないときは --bucket の代わりに --skip-s3 を付ける。
  認証情報は AWS_PROFILE などの環境変数で渡す。`;

/** コマンドラインの引数を読む。足りない・知らない引数は落とす */
export function parseArgs(argv: string[]): Options {
  const values: Record<string, string> = {};
  let apply = false;
  let skipS3 = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--apply') {
      apply = true;
      continue;
    }
    if (arg === '--skip-s3') {
      skipS3 = true;
      continue;
    }
    const name = arg.replace(/^--/, '');
    if (!arg.startsWith('--') || !['table', 'bucket', 'from', 'to', 'region'].includes(name)) {
      throw new Error(`知らない引数です: ${arg}\n\n${USAGE}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} に値がありません\n\n${USAGE}`);
    values[name] = value;
    index += 1;
  }

  for (const required of ['table', 'from', 'to']) {
    if (!values[required]) throw new Error(`--${required} が要ります\n\n${USAGE}`);
  }
  if (!values.bucket && !skipS3) throw new Error(`--bucket が要ります（画像を扱わないなら --skip-s3）\n\n${USAGE}`);
  if (values.bucket && skipS3) throw new Error('--bucket と --skip-s3 は一緒に使えません');

  assertSubs(values.from!, values.to!);

  return {
    table: values.table!,
    ...(values.bucket ? { bucket: values.bucket } : {}),
    from: values.from!,
    to: values.to!,
    region: values.region ?? 'ap-northeast-1',
    apply,
  };
}
