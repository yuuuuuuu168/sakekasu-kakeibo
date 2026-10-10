import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import {
  SEED_CATEGORIES,
  withLaterSeeds,
  buildMonthlyReport,
  previousMonth,
  type Budget,
  type Category,
  type Transaction,
} from '@kakeibo/core';

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
      // 1 人分の失敗で全体を落とさない。利用者は 1 人だが、将来増えたときのため
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
 */
async function listUsers(): Promise<string[]> {
  const found = new Set<string>();
  let startKey: Record<string, unknown> | undefined;

  do {
    const page = await documents.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        ProjectionExpression: 'pk',
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    for (const item of page.Items ?? []) {
      if (typeof item.pk === 'string') found.add(item.pk);
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);

  return [...found];
}

async function generate(pk: string, month: string): Promise<void> {
  const items = await queryAll(pk);

  const transactions: Transaction[] = [];
  let categories: Category[] = SEED_CATEGORIES;
  let budget: Budget | undefined;

  for (const item of items) {
    const sk = String(item.sk);
    if (sk.startsWith('TXN#')) transactions.push(item as unknown as Transaction);
    else if (sk === 'CONFIG#categories' && Array.isArray(item.categories)) categories = withLaterSeeds(item.categories as Category[]);
    else if (sk === `BUDGET#${month}`) budget = { month, limits: (item.limits ?? {}) as Record<string, number> };
  }

  const report = buildMonthlyReport({ month, transactions, categories, budget });

  await documents.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: { pk, sk: `REPORT#${month}`, month, report, updatedAt: new Date().toISOString() },
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
