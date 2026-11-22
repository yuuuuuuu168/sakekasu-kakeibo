import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { Context } from 'aws-lambda';
import { ImapFlow, type MailboxObject, type MessageEnvelopeObject } from 'imapflow';
import { simpleParser } from 'mailparser';
import { decideRelay, type MailRelayFilter } from '@kakeibo/core';
import { requireEnv } from '../shared/env';
import { SK, mailRelayFilterOf } from '../shared/snapshot-items';
import { MAIL_RELAY_PARTITION_PREFIX, userPk } from '../shared/user-partition';
import { MAX_SOURCE_BYTES, buildForward, buildOversizeNotice, type ForwardTarget, type OriginalHeaders } from './forward';
import {
  AUTH_ALERT_AFTER,
  MAX_PER_RUN,
  isTooOld,
  isWatchedFolder,
  orderFolders,
  parseRelayConfig,
  pickUids,
  planRun,
  shouldTryLogin,
  stateFromItem,
  type RelayConfig,
  type RelayState,
} from './plan';

/*
 * Yahoo!メールを IMAP で 5 分ごとに見に行き、新しく届いたメールを Muse Mail へ SES でコピーする。
 * Yahoo! の自動転送は転送したメールを Yahoo! 側に残さないので、こちらで読みに行く。
 * 見るのは受信箱と個人フォルダ（迷惑メール・ゴミ箱・送信済み・下書きは外す。plan.ts の isWatchedFolder）で、
 * Yahoo! の振り分けで直接フォルダに入るメールも拾う。フォルダごとに最後に送った UID を覚える。
 * どのフォルダも読み取り専用で開く（既読にしない、動かさない、消さない）。
 * 届いてから 1 日より古いメールは送らない（手で別のフォルダへ移した古いメールを、新着として送り直さないため）。
 *
 * 送るのは、設定画面で決めた条件（差出人か件名のどちらかに当たる）のメールだけ。条件が空なら全部を送る。
 * 条件は宛名の情報（IMAP の ENVELOPE）だけで判定し、当たらないメールは本文を取りに行かない。
 *
 * メールの中身は保存しない。ログにも件名・差出人・本文は出さず、UID・大きさ・添付の数・結果だけを出す。
 * 設定（Yahoo! JAPAN ID とパスワード、送り先）は Secrets Manager にあり、入っていなければ何もしない。
 */

const TABLE_NAME = requireEnv('TABLE_NAME');
const SECRET_ID = requireEnv('MAIL_RELAY_SECRET_ID');
const FROM_ADDRESS = requireEnv('MAIL_RELAY_FROM');

const IMAP_HOST = 'imap.mail.yahoo.co.jp';
const IMAP_PORT = 993;
const STATE_KEY = { pk: `${MAIL_RELAY_PARTITION_PREFIX}yahoo`, sk: 'STATE' };
/** 残り時間がこれを切ったら、次のメールに手を付けずに終える（続きは次の回） */
const STOP_MARGIN_MS = 30_000;

const secrets = new SecretsManagerClient({});
const ses = new SESv2Client({});
const documents = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });

export async function handler(_event: unknown, context?: Pick<Context, 'getRemainingTimeInMillis'>): Promise<void> {
  const now = new Date();
  const config = await loadConfig();
  if (!config) {
    console.info('[mail-relay]', JSON.stringify({ 結果: '未設定' }));
    return;
  }

  const state = await loadState();
  if (state.authFailures >= AUTH_ALERT_AFTER) {
    // アラーム（mail-relay-auth-failing）はこの文言を数える。間隔を空けて試さない回にも出し、直るまで鳴らし続ける
    console.warn('[mail-relay] auth-failing', JSON.stringify({ 続けて失敗: state.authFailures }));
  }
  if (!shouldTryLogin(state, now)) {
    console.info('[mail-relay]', JSON.stringify({ 結果: '認証の失敗が続いているので間隔を空けた' }));
    return;
  }

  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: config.user, pass: config.password },
    // 既定のロガーは IMAP のやりとりを出す。件名や宛名が CloudWatch に載るので止める
    logger: false,
    connectionTimeout: 15_000,
    socketTimeout: 60_000,
  });

  try {
    await client.connect();
  } catch (cause) {
    if ((cause as { authenticationFailed?: boolean }).authenticationFailed) {
      await saveState({ ...state, authFailures: state.authFailures + 1, lastAuthFailureAt: now.toISOString() });
      console.warn('[mail-relay] auth-failed', JSON.stringify({ 続けて失敗: state.authFailures + 1 }));
      return;
    }
    fail('接続', cause);
    return;
  }

  let current: RelayState = { ...state, authFailures: 0, lastAuthFailureAt: undefined };
  const save = async (next: RelayState) => {
    current = next;
    await saveState(current);
  };
  const summary = { フォルダ: 0, 送った: 0, 条件に当たらず: 0, 古いので送らず: 0, 大きすぎ: 0, 添付を外した: 0, 残り: 0 };
  try {
    const paths = orderFolders(
      (await client.list()).filter((folder) => isWatchedFolder(folder)).map((folder) => folder.path),
    );
    // 消したフォルダの進み具合は落とす（同じ名前で作り直したら、初めて見るフォルダとして数え直す）
    const folders = Object.fromEntries(Object.entries(current.folders).filter(([path]) => paths.includes(path)));
    if (Object.keys(folders).length !== Object.keys(current.folders).length) await save({ ...current, folders });

    const filter = await loadFilter(config.sub);
    const target: ForwardTarget = { from: FROM_ADDRESS, to: config.forwardTo };
    const outOfTime = () => context !== undefined && context.getRemainingTimeInMillis() < STOP_MARGIN_MS;

    for (const path of paths) {
      if (outOfTime()) break;
      summary.フォルダ += 1;
      const lock = await client.getMailboxLock(path, { readOnly: true });
      try {
        const mailbox = client.mailbox as MailboxObject;
        const uidValidity = String(mailbox.uidValidity);
        const plan = planRun(current.folders[path], { uidValidity, uidNext: mailbox.uidNext });
        if (plan.kind === 'baseline') {
          await save({ ...current, folders: { ...current.folders, [path]: { uidValidity, lastUid: plan.lastUid } } });
          // UIDVALIDITY が変わったときは取りこぼしがありうる。アラーム（mail-relay-uid-reset）がこの文言を数え、人に知らせる
          if (plan.reason !== '初回') console.warn('[mail-relay] uid-reset');
          // フォルダの名前は出す（どのフォルダを見始めたかが分かるように）。件名・差出人は出さない
          console.info('[mail-relay]', JSON.stringify({ 結果: '基準を決めた', フォルダ: path, 理由: plan.reason, UID: plan.lastUid }));
          continue;
        }

        const listed: { uid: number; size: number; internalDate?: Date | string; envelope: OriginalHeaders; fromAddresses: string[] }[] = [];
        for await (const message of client.fetch(
          `${plan.afterUid + 1}:*`,
          { uid: true, size: true, envelope: true, internalDate: true },
          { uid: true },
        )) {
          listed.push({
            uid: message.uid,
            size: message.size ?? 0,
            internalDate: message.internalDate,
            envelope: envelopeHeaders(message.envelope),
            fromAddresses: (message.envelope?.from ?? []).map((address) => address.address ?? '').filter((address) => address !== ''),
          });
        }
        const pending = listed.filter((message) => message.uid > plan.afterUid).length;
        // 1 回の上限（MAX_PER_RUN）はフォルダをまたいで数える。処理した数は送った・送らなかったの合計
        const handled = () => summary.送った + summary.条件に当たらず + summary.古いので送らず;
        const uids = pickUids(
          listed.map((message) => message.uid),
          plan.afterUid,
          MAX_PER_RUN - handled(),
        );
        summary.残り += pending - uids.length;

        for (const [index, uid] of uids.entries()) {
          if (outOfTime()) {
            summary.残り += uids.length - index;
            break;
          }
          const meta = listed.find((message) => message.uid === uid)!;
          const advance = () => save({ ...current, folders: { ...current.folders, [path]: { uidValidity, lastUid: uid } } });

          // 送らないメールも処理済みとして進める。後から条件を広げても、過去のメールは遡って送らない
          if (isTooOld(meta.internalDate, now)) {
            await advance();
            summary.古いので送らず += 1;
            continue;
          }
          if (decideRelay(filter, { fromAddresses: meta.fromAddresses, subject: meta.envelope.subject }) === 'none') {
            await advance();
            summary.条件に当たらず += 1;
            continue;
          }

          let raw: Buffer;
          if (meta.size > MAX_SOURCE_BYTES) {
            raw = await buildOversizeNotice(meta.envelope, meta.size, target);
            summary.大きすぎ += 1;
          } else {
            const fetched = await client.fetchOne(String(uid), { source: true }, { uid: true });
            if (!fetched || !fetched.source) throw new Error(`UID ${uid} の本文を取れなかった`);
            const built = await buildForward(await simpleParser(fetched.source), target);
            raw = built.raw;
            if (built.dropped.length > 0) summary.添付を外した += 1;
          }
          await ses.send(new SendEmailCommand({ Content: { Raw: { Data: raw } } }));
          // 1 通ごとに進める。途中で落ちても、送った分を次の回で送り直さない
          await advance();
          summary.送った += 1;
          console.info('[mail-relay] sent', JSON.stringify({ フォルダ: path, UID: uid, 大きさ: meta.size }));
        }
      } finally {
        lock.release();
      }
    }
    if (state.authFailures > 0) await saveState(current);
    console.info('[mail-relay]', JSON.stringify({ 結果: '完了', ...summary }));
  } catch (cause) {
    if (state.authFailures > 0) await saveState(current).catch(() => undefined);
    fail('取得・送信', cause);
  } finally {
    await client.logout().catch(() => undefined);
  }
}

/** IMAP の ENVELOPE を、本文の頭に書く形にする（大きすぎて中身を取りに行かなかったメール用） */
function envelopeHeaders(envelope: MessageEnvelopeObject | undefined): OriginalHeaders {
  const list = (addresses: { name?: string; address?: string }[] | undefined) =>
    (addresses ?? []).map((address) => (address.name ? `${address.name} <${address.address ?? ''}>` : (address.address ?? ''))).join(', ');
  return {
    from: list(envelope?.from),
    to: list(envelope?.to),
    date: envelope?.date ? new Date(envelope.date) : undefined,
    subject: envelope?.subject ?? '',
    messageId: envelope?.messageId,
  };
}

/**
 * 認証以外の失敗。例外は握って関数は正常に終える（非同期の呼び出しの再試行で同じメールを重ねて送らないため）。
 * アラーム（mail-relay-failures）はこの文言を数える。メッセージに件名などが載らないよう、種類と出どころだけを出す
 */
function fail(stage: string, cause: unknown): void {
  const error = cause as { name?: string; code?: string; responseStatus?: string };
  console.error('[mail-relay] failed', JSON.stringify({ 段階: stage, 種類: error?.name ?? 'unknown', code: error?.code, 応答: error?.responseStatus }));
}

async function loadConfig(): Promise<RelayConfig | undefined> {
  try {
    const secret = await secrets.send(new GetSecretValueCommand({ SecretId: SECRET_ID }));
    return parseRelayConfig(secret.SecretString);
  } catch (cause) {
    // 例外にはシークレットの ARN が載るので、名前だけ出す
    fail('設定の読み込み', cause);
    return undefined;
  }
}

/**
 * 設定画面で決めた転送の条件。利用者の sub がシークレットに無い、または条件の行がまだ無ければ空（全部を送る）。
 * 回ごとに読み直すので、画面で直した条件は次の回（5 分以内）から効く
 */
async function loadFilter(sub: string | undefined): Promise<MailRelayFilter> {
  if (!sub) return { senders: [], subjectWords: [] };
  // 読む項目を指定する。中継の権限は mailRelayFilter の項目しか読めず、指定の無い読み取りは拒まれる（api-stack.ts）
  const found = await documents.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk: userPk(sub), sk: SK.mailRelayFilter },
      ProjectionExpression: 'mailRelayFilter',
    }),
  );
  return mailRelayFilterOf(found.Item?.mailRelayFilter);
}

async function loadState(): Promise<RelayState> {
  const found = await documents.send(new GetCommand({ TableName: TABLE_NAME, Key: STATE_KEY }));
  return stateFromItem(found.Item);
}

/** 行は丸ごと書き換える。受信箱しか見ていなかった頃の uidValidity / lastUid は、ここで行から消える */
async function saveState(state: RelayState): Promise<void> {
  const { folders, authFailures, lastAuthFailureAt } = state;
  await documents.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: { ...STATE_KEY, folders, authFailures, lastAuthFailureAt, updatedAt: new Date().toISOString() },
    }),
  );
}
