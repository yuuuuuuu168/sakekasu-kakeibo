import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import type { Snapshot } from '@kakeibo/core';
import { requireEnv } from '../shared/env';
import type { Json } from '../shared/http';
import { SK, snapshotFromItems } from '../shared/snapshot-items';
import { userPk } from '../shared/user-partition';

/*
 * 利用者のパーティション（USER#{sub}）の読み書き。キーはどれも sub から組み立て、本文のキーは使わない。
 * OCR のジョブの行（OCR#{sub}）は ocr.ts が扱う。
 */

export const TABLE_NAME = requireEnv('TABLE_NAME');

export const documents = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

/** BatchWrite が 1 回に受け取る件数の上限 */
const BATCH_SIZE = 25;

export async function loadSnapshot(sub: string): Promise<Snapshot> {
  const items: Json[] = [];
  let startKey: Record<string, unknown> | undefined;

  do {
    const page = await documents.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': userPk(sub) },
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    items.push(...((page.Items ?? []) as Json[]));
    startKey = page.LastEvaluatedKey;
  } while (startKey);

  // 欠けは補わずに返す。補うのは画面の store（core の normalizeSnapshot）
  return snapshotFromItems(items);
}

export async function put(sub: string, sk: string, attributes: Json): Promise<void> {
  await documents.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: { ...attributes, pk: userPk(sub), sk, updatedAt: new Date().toISOString() },
    }),
  );
}

export async function remove(sub: string, sk: string): Promise<void> {
  await documents.send(new DeleteCommand({ TableName: TABLE_NAME, Key: { pk: userPk(sub), sk } }));
}

/** 明細をまとめて書く。書き込みは上書きでよい（重複の判定は取り込み画面で済んでいる） */
export async function putTransactionRows(sub: string, rows: (Json & { id: string })[]): Promise<void> {
  for (let index = 0; index < rows.length; index += BATCH_SIZE) {
    const chunk = rows.slice(index, index + BATCH_SIZE);
    let request: Record<string, unknown[]> | undefined = {
      [TABLE_NAME]: chunk.map((txn) => ({
        // キーは展開の後ろに置く。本文に pk / sk があっても、sub から組み立てた値が勝つ
        PutRequest: { Item: { ...txn, pk: userPk(sub), sk: SK.transaction(txn.id) } },
      })),
    };

    // 未処理分は返ってくるので、空になるまで送り直す
    for (let attempt = 0; attempt < 5 && request && Object.keys(request).length > 0; attempt += 1) {
      const result = await documents.send(new BatchWriteCommand({ RequestItems: request as never }));
      request = result.UnprocessedItems as Record<string, unknown[]> | undefined;
      if (request && Object.keys(request).length > 0) {
        await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
      }
    }
  }
}

/** 月次レポートの Lambda が作って置いたレポート。無ければ undefined */
export async function getReport(sub: string, month: string): Promise<unknown> {
  const found = await documents.send(new GetCommand({ TableName: TABLE_NAME, Key: { pk: userPk(sub), sk: SK.report(month) } }));
  return found.Item?.report;
}
