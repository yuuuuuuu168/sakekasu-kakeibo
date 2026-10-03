/**
 * 旧ユーザープールの sub のデータを、共通ログインの sub の下へコピーする。
 *
 * ログインを共通のユーザープールへ移すと sub が変わり、API は新しい sub の下
 * （`USER#<新 sub>`、`receipts/<新 sub>/`）しか読まなくなる。そのままだと家計簿が空に見えるので、
 * 旧 sub の下のデータを写す。手順は docs/operations.md の「共通ログインへの切り替え」にある。
 *
 * - 既定は dry-run。読むだけで、写す件数・既にある件数と例を出す。`--apply` で書き込む
 * - 書き込みは条件付き。新しいキーに既にある項目・画像は上書きしない。何度流しても同じ結果になる
 * - 旧データは消さない。切り戻せるように残し、消すのは別の作業にする
 * - 画像を先に写し、項目は後に写す。項目の imageKey が指す先を先に用意しておくため
 *
 * 人が Mac から管理者権限のプロファイルで流す（Actions や Claude のセッションからは流さない）。
 * 読み取り専用の verify プロファイルでは、DynamoDB の項目も S3 の本文も読めないので通らない。
 *
 * 例:
 *   cd infra
 *   AWS_PROFILE=sakekasu-builder npx tsx scripts/copy-user-data/index.ts \
 *     --table sakekasu-kakeibo-dev --bucket sakekasu-kakeibo-dev-receipts-<アカウント ID> \
 *     --from <旧 sub> --to <新 sub>
 */
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { CopyObjectCommand, HeadObjectCommand, ListObjectsV2Command, NotFound, S3Client } from '@aws-sdk/client-s3';
import { type Item, type Options, parseArgs, receiptPrefix, rewriteItem, rewriteObjectKey, userPk } from './plan';

/** 例として出す件数 */
const SAMPLES = 5;

type Tally = { copy: number; exists: number; samples: string[]; existing: string[] };

function tally(): Tally {
  return { copy: 0, exists: 0, samples: [], existing: [] };
}

async function main(): Promise<void> {
  let options: Options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(2);
  }

  const mode = options.apply ? '書き込む（--apply）' : 'dry-run（読むだけ）';
  console.log(`モード: ${mode}`);
  console.log(`テーブル: ${options.table} / バケット: ${options.bucket ?? '（扱わない）'} / リージョン: ${options.region}`);
  console.log(`旧: ${userPk(options.from)} → 新: ${userPk(options.to)}\n`);

  const objects = options.bucket ? await copyObjects(options, options.bucket) : undefined;
  const items = await copyItems(options);

  console.log('\n== まとめ ==');
  if (objects) report('レシート画像', objects, options.apply);
  report('DynamoDB の項目', items.tally, options.apply);

  if (items.leftovers.length > 0) {
    console.warn('\n警告: 付け替えた後も旧 sub を含む値があります。plan.ts の規則に足りない場所がないか確かめてください。');
    for (const line of items.leftovers.slice(0, 20)) console.warn(`  ${line}`);
  }
  if (items.tally.exists > 0 || (objects?.exists ?? 0) > 0) {
    console.warn(
      '\n注意: 新しい sub の下に既にあるものは上書きしていません。共通ログインで入ってから設定や明細を' +
        '触っていると、旧データの同じ項目（カテゴリ、ルールなど）が写りません。例を見て判断してください。',
    );
  }
  if (!options.apply) console.log('\ndry-run なので何も書いていません。よければ --apply を付けてもう一度流します。');
}

function report(label: string, result: Tally, apply: boolean): void {
  console.log(`${label}: ${apply ? '写した' : '写す'} ${result.copy} 件 / 新しい側に既にある ${result.exists} 件`);
  for (const sample of result.samples) console.log(`  例: ${sample}`);
  for (const sample of result.existing) console.log(`  既にある: ${sample}`);
}

/** レシート画像を receipts/<旧 sub>/ から receipts/<新 sub>/ へコピーする */
async function copyObjects(options: Options, bucket: string): Promise<Tally> {
  const s3 = new S3Client({ region: options.region });
  const result = tally();
  let token: string | undefined;

  do {
    const page = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: receiptPrefix(options.from), ContinuationToken: token }),
    );
    for (const object of page.Contents ?? []) {
      const source = object.Key!;
      const target = rewriteObjectKey(source, options.from, options.to)!;

      // 写し先に既にあれば触らない。中身は同じ画像のはずなので、上書きする理由が無い
      if (await objectExists(s3, bucket, target)) {
        result.exists += 1;
        if (result.existing.length < SAMPLES) result.existing.push(target);
        continue;
      }

      if (options.apply) {
        await s3.send(
          new CopyObjectCommand({
            Bucket: bucket,
            Key: target,
            CopySource: `${bucket}/${source.split('/').map(encodeURIComponent).join('/')}`,
            // メタデータ（Content-Type など）は元のまま
            MetadataDirective: 'COPY',
          }),
        );
      }
      result.copy += 1;
      if (result.samples.length < SAMPLES) result.samples.push(`${source} → ${target}`);
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);

  return result;
}

async function objectExists(s3: S3Client, bucket: string, key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (cause) {
    if (cause instanceof NotFound || (cause as { name?: string }).name === 'NotFound') return false;
    throw cause;
  }
}

/** USER#<旧 sub> の全項目を USER#<新 sub> へ写す。sk はそのまま */
async function copyItems(options: Options): Promise<{ tally: Tally; leftovers: string[] }> {
  const documents = DynamoDBDocumentClient.from(new DynamoDBClient({ region: options.region }), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const result = tally();
  const leftovers: string[] = [];
  let startKey: Record<string, unknown> | undefined;

  do {
    const page = await documents.send(
      new QueryCommand({
        TableName: options.table,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': userPk(options.from) },
        ConsistentRead: true,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );

    for (const source of (page.Items ?? []) as Item[]) {
      const { item, leftovers: found } = rewriteItem(source, options.from, options.to);
      const sk = String(item.sk);
      leftovers.push(...found.map((where) => `${sk}: ${where}`));

      const written = options.apply ? await putIfAbsent(documents, options.table, item) : !(await itemExists(documents, options.table, item));
      if (written) {
        result.copy += 1;
        if (result.samples.length < SAMPLES) result.samples.push(sk);
      } else {
        result.exists += 1;
        if (result.existing.length < SAMPLES) result.existing.push(sk);
      }
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);

  return { tally: result, leftovers };
}

/** 新しいキーに無いときだけ書く。書いたら true、既にあれば false */
async function putIfAbsent(documents: DynamoDBDocumentClient, table: string, item: Item): Promise<boolean> {
  try {
    await documents.send(
      new PutCommand({ TableName: table, Item: item, ConditionExpression: 'attribute_not_exists(pk)' }),
    );
    return true;
  } catch (cause) {
    if (cause instanceof ConditionalCheckFailedException) return false;
    throw cause;
  }
}

async function itemExists(documents: DynamoDBDocumentClient, table: string, item: Item): Promise<boolean> {
  const found = await documents.send(
    new GetCommand({ TableName: table, Key: { pk: item.pk, sk: item.sk }, ProjectionExpression: 'pk', ConsistentRead: true }),
  );
  return found.Item !== undefined;
}

main().catch((cause: unknown) => {
  console.error('途中で失敗しました。書き込みは条件付きなので、原因を直してからそのまま流し直せます。');
  console.error(cause);
  process.exit(1);
});
