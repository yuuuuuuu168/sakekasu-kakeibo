import { createHash } from 'node:crypto';
import { ConditionalCheckFailedException, DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { normalizeSnapshot, type Category, type CategoryRule, type Receipt } from '@kakeibo/core';
import { requireEnv } from '../shared/env';
import { SK } from '../shared/snapshot-items';
import { MAIL_INBOX_PARTITION_PREFIX, userPk } from '../shared/user-partition';

/*
 * 下書き登録 API の DynamoDB の読み書き。
 *
 * レシートは画面と同じ利用者のパーティション（USER#{sub}）に置く。重複の印と 1 日の呼び出しの数は
 * 別のパーティション（MAILINBOX#{sub}）に置き、画面が読む保存データ（GET /snapshot）に混ぜない。
 */

const TABLE_NAME = requireEnv('TABLE_NAME');

const inboxPk = (sub: string) => `${MAIL_INBOX_PARTITION_PREFIX}${sub}`;

/** 1 日（日本時間）に受ける呼び出しの数。鍵が漏れたときに置かれる下書きの数を抑える */
export const MAIL_DAILY_LIMIT = 20;

const documents = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

/**
 * 重複の印の行の sk。注文番号も Message-ID も長さが決まらず記号も混ざるので、ハッシュにして長さを揃える。
 * 印は下書きを消しても残る。人が消した注文を、後から届いた発送のお知らせで置き直さないため
 */
export const markerSk = {
  order: (orderNumber: string) => `ORDER#${digest(orderNumber)}`,
  message: (messageId: string) => `MESSAGE#${digest(messageId)}`,
};

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** 日本時間の日付（YYYY-MM-DD） */
export function jstDay(now: Date): string {
  return new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
}

/**
 * 今日の呼び出しを 1 つ数える。上限に届いていたら数えずに false を返す。
 * 行には TTL（テーブルの expiresAt）を付け、3 日で消えるようにしておく
 */
export async function countCall(sub: string, now: Date): Promise<boolean> {
  try {
    await documents.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { pk: inboxPk(sub), sk: `DAY#${jstDay(now)}` },
        UpdateExpression: 'ADD calls :one SET expiresAt = :expiresAt',
        ConditionExpression: 'attribute_not_exists(calls) OR calls < :limit',
        ExpressionAttributeValues: {
          ':one': 1,
          ':limit': MAIL_DAILY_LIMIT,
          ':expiresAt': Math.floor(now.getTime() / 1000) + 3 * 86_400,
        },
      }),
    );
    return true;
  } catch (cause) {
    if (cause instanceof ConditionalCheckFailedException) return false;
    throw cause;
  }
}

/** 既存の判定とカテゴリ判定に要るものだけを読む（明細は読まない） */
export async function loadContext(sub: string): Promise<{ receipts: Receipt[]; categories: Category[]; rules: CategoryRule[] }> {
  const receipts: Receipt[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await documents.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': userPk(sub), ':prefix': SK.receipt('') },
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    receipts.push(...((page.Items ?? []) as Receipt[]));
    startKey = page.LastEvaluatedKey;
  } while (startKey);

  const [categories, rules] = await Promise.all(
    [SK.categories, SK.rules].map(async (sk) => {
      const found = await documents.send(new GetCommand({ TableName: TABLE_NAME, Key: { pk: userPk(sub), sk } }));
      return found.Item;
    }),
  );
  // カテゴリの行がまだ無い利用者には、画面と同じ初期のカテゴリを当てる
  const snapshot = normalizeSnapshot({
    categories: (categories?.categories as Category[] | undefined) ?? [],
    rules: (rules?.rules as CategoryRule[] | undefined) ?? [],
  });
  return { receipts, categories: snapshot.categories, rules: snapshot.rules };
}

/**
 * レシートと重複の印をまとめて書く。印がもうあれば（同じ注文のメールがほぼ同時に届いた）、
 * 何も書かずに先に置かれた下書きの ID を返す
 */
export async function createReceipt(
  sub: string,
  receipt: Receipt,
): Promise<{ created: true } | { created: false; existingId: string | undefined }> {
  const markers = [
    ...(receipt.orderNumber ? [markerSk.order(receipt.orderNumber)] : []),
    ...(receipt.messageId ? [markerSk.message(receipt.messageId)] : []),
  ];
  try {
    await documents.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: TABLE_NAME,
              Item: { ...receipt, pk: userPk(sub), sk: SK.receipt(receipt.id), updatedAt: new Date().toISOString() },
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
          ...markers.map((sk) => ({
            Put: {
              TableName: TABLE_NAME,
              Item: { pk: inboxPk(sub), sk, receiptId: receipt.id },
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          })),
        ],
      }),
    );
    return { created: true };
  } catch (cause) {
    if (!(cause instanceof TransactionCanceledException)) throw cause;
    if (!cause.CancellationReasons?.some((reason) => reason.Code === 'ConditionalCheckFailed')) throw cause;
    return { created: false, existingId: await findMarker(sub, markers) };
  }
}

async function findMarker(sub: string, markers: string[]): Promise<string | undefined> {
  for (const sk of markers) {
    const found = await documents.send(new GetCommand({ TableName: TABLE_NAME, Key: { pk: inboxPk(sub), sk } }));
    if (typeof found.Item?.receiptId === 'string') return found.Item.receiptId;
  }
  return undefined;
}

/** 印だけを先に引く。レシートの行を人が消していても、印が残っていれば既存として返す */
export async function findMarkedReceiptId(sub: string, orderNumber: string | undefined, messageId: string): Promise<string | undefined> {
  return findMarker(sub, [...(orderNumber ? [markerSk.order(orderNumber)] : []), markerSk.message(messageId)]);
}
