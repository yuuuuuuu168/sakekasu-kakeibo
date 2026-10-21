import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { buildMonthlyReport, normalizeSnapshot, previousMonth, reportInputFor } from '@kakeibo/core';
import { SK, snapshotFromItems } from '../shared/snapshot-items';
import { USER_PARTITION_PREFIX, isUserPartition } from '../shared/user-partition';

const TABLE_NAME = requireEnv('TABLE_NAME');

const documents = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

type Event = {
  /** 対象の月。省略すると前月。手で呼び直すときに使う */
  month?: string;
};

/**
 * 毎月 1 日に前月のレポートを作って置いておく。画面はそれを読むだけにする。
 * 作っておく理由は、月が締まればもう数字が変わらないこと、それに叱りの文面が
 * 生成のたびに揺れないようにしたいこと。
 */
export async function handler(event: Event = {}): Promise<{ month: string; users: number }> {
  const month = event.month ?? previousMonth(currentMonth());
  const users = await listUsers();

  for (const pk of users) {
    try {
      await generate(pk, month);
    } catch (cause) {
      // テーブルにいる pk を全部回すので、1 つの失敗でほかの pk のレポートまで止めない
      console.error('[monthly-report] failed', { pk, month, cause });
    }
  }

  console.log('[monthly-report] done', { month, users: users.length });
  return { month, users: users.length };
}

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

/**
 * テーブルにいる利用者を列挙する。pk だけを射影した Scan。
 * 利用者 1 人・明細が年に千件ほどの規模なので、GSI を足すより安い。
 *
 * 同じテーブルに OCR のジョブの行（`OCR#{sub}`）も置いているので、利用者のパーティション
 * （`USER#{sub}`）だけを拾う。絞らないと、ジョブのパーティションにも空のレポートを書き込む。
 */
async function listUsers(): Promise<string[]> {
  const found = new Set<string>();
  let startKey: Record<string, unknown> | undefined;

  do {
    const page = await documents.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        ProjectionExpression: 'pk',
        FilterExpression: 'begins_with(pk, :user)',
        ExpressionAttributeValues: { ':user': USER_PARTITION_PREFIX },
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    for (const item of page.Items ?? []) {
      if (isUserPartition(item.pk)) found.add(item.pk);
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);

  return [...found];
}

/**
 * 保存データの組み方と補い方は、画面と同じもの（snapshotFromItems → core の normalizeSnapshot）を通す。
 * 別に書いていた頃は、カテゴリの行が空のときに値引きのカテゴリしか残らず、画面のレポートと食い違った
 */
async function generate(pk: string, month: string): Promise<void> {
  const snapshot = normalizeSnapshot(snapshotFromItems(await queryAll(pk)));
  const report = buildMonthlyReport(reportInputFor(snapshot, month));

  await documents.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: { pk, sk: SK.report(month), month, report, updatedAt: new Date().toISOString() },
    }),
  );
}

async function queryAll(pk: string): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let startKey: Record<string, unknown> | undefined;

  do {
    const page = await documents.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': pk },
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    items.push(...(page.Items ?? []));
    startKey = page.LastEvaluatedKey;
  } while (startKey);

  return items;
}
