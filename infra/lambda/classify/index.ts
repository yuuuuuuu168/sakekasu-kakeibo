import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { TypeSafeClient, choice, type ChoiceQuestion, type JsonValue } from '@typesafe-ai/sdk';
import {
  childChoiceSpecs,
  decideVerdicts,
  parentChoiceSpecs,
  type Category,
  type ChoiceAnswer,
  type ChoiceSpec,
  type ClassifyKind,
  type ClassifySubject,
  type ClassifyTarget,
  type Verdict,
} from '@kakeibo/core';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';

/**
 * カテゴリ判定。レシートの品目名と明細の店舗名を、大カテゴリ → 小カテゴリの 2 段で決める。
 *
 * OCR（Bedrock）と分けてあるのは、やっていることが別だから。画像から文字を起こすのは
 * 生成の仕事で Claude が向いているが、「これは食費か日用品か」は選択肢から 1 つ選ぶ仕事で、
 * Jev は答えと一緒に校正された確信度を返す。確信度があると、そのまま入れる・人に見せる・
 * 未分類に落とす、の線を数字で引ける。
 *
 * 判定の材料づくりと採否は packages/core にある（画面からも同じ規則で読めるようにするため）。
 * この関数が持っているのは、鍵の取り出しと Jev の呼び出しだけ。
 */

/** API キーを入れた Secrets Manager のシークレット。中身は鍵の文字列そのまま */
const SECRET_ID = requireEnv('TYPESAFE_SECRET_ID');
/**
 * モデル ID は環境変数から取り、既定値を持たない。差し替えたときに
 * CDK の側だけを見れば分かるようにしておく（ocr-receipt と同じ考え方）。
 */
const MODEL_ID = requireEnv('TYPESAFE_MODEL_ID');

/** 1 リクエストに載せる質問の数。刻んでおくと、束が 1 つ落ちても残りの答えは活きる */
const QUESTIONS_PER_REQUEST = 20;
/** 1 回の呼び出しで見る対象の上限。明細を一気に取り込んでも、ここで止める */
const MAX_SUBJECTS = 100;

const secrets = new SecretsManagerClient({});

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> {
  const sub = event.requestContext.authorizer?.jwt?.claims?.sub;
  if (typeof sub !== 'string' || sub === '') return json(401, { message: 'サインインが必要です' });

  const target = parseTarget(parseBody(event.body, event.isBase64Encoded));
  if (!target) return json(400, { message: '判定する対象とカテゴリが要ります' });

  try {
    return json(200, { verdicts: await classify(target) });
  } catch (cause) {
    /*
     * 外に返すのは固定の文言だけにする。鍵が入っていないときの例外には
     * シークレットの ARN（アカウント ID・リージョン・名前）が載っていて、
     * そのまま返すと画面に出る。詳しい理由は CloudWatch Logs の側に残す。
     * 呼び出し側はどの失敗も同じように飲み込んでキーワード表に落ちるので、
     * 文言を分ける意味も無い。
     */
    console.error('[classify] failed', cause);
    return json(502, { message: 'カテゴリの判定に失敗しました' });
  }
}

/**
 * 外から来た本文を判定できる形に直す。壊れた要素は捨てる。
 * 落とした分は「判定しなかった」として扱われ、呼び出し側のフォールバックに回る。
 */
export function parseTarget(body: Record<string, unknown>): ClassifyTarget | undefined {
  const kind: ClassifyKind = body.kind === 'merchant' ? 'merchant' : 'item';

  const categories = asArray(body.categories)
    .filter((value): value is Record<string, unknown> => typeof value === 'object' && value !== null)
    .filter((value) => typeof value.id === 'string' && value.id !== '' && typeof value.label === 'string')
    .map(
      (value): Category => ({
        id: value.id as string,
        label: value.label as string,
        order: typeof value.order === 'number' && Number.isFinite(value.order) ? value.order : 0,
        ...(value.archived === true ? { archived: true } : {}),
        ...(typeof value.parentId === 'string' && value.parentId !== '' ? { parentId: value.parentId } : {}),
      }),
    );

  const seen = new Set<string>();
  const subjects = asArray(body.subjects)
    .filter((value): value is Record<string, unknown> => typeof value === 'object' && value !== null)
    .map((value): ClassifySubject | undefined => {
      const key = typeof value.key === 'string' ? value.key : '';
      const text = typeof value.text === 'string' ? value.text.trim() : '';
      if (key === '' || text === '' || seen.has(key)) return undefined;
      seen.add(key);
      const context = typeof value.context === 'string' ? value.context.trim() : '';
      return { key, text, ...(context ? { context } : {}) };
    })
    .filter((subject): subject is ClassifySubject => subject !== undefined)
    .slice(0, MAX_SUBJECTS);

  if (subjects.length === 0 || categories.length === 0) return undefined;
  return { kind, subjects, categories };
}

async function classify(target: ClassifyTarget): Promise<Record<string, Verdict>> {
  const parentSpecs = parentChoiceSpecs(target);
  // カテゴリが 1 つも選べない状態。呼ぶだけ無駄なので、全部未分類として返す
  if (parentSpecs.length === 0) return decideVerdicts(target, {}, {});

  const client = await clientOnce();
  const state = buildState(target);

  const parentAnswers = await ask(client, state, parentSpecs);
  const childAnswers = await ask(client, state, childChoiceSpecs(target, parentAnswers));

  return decideVerdicts(target, parentAnswers, childAnswers);
}

/**
 * モデルに見せるデータ。1 枚のレシートの品目を全部入れてあるのは、
 * 他に何を買ったかが品目 1 つの判断を助けるため（惣菜と洗剤が並んでいればスーパー）。
 */
export function buildState(target: ClassifyTarget): Record<string, JsonValue> {
  return {
    種類: target.kind === 'merchant' ? 'クレジットカードや PayPay の明細に並んだ店舗名' : 'レシートから読み取った品目名',
    対象: target.subjects.map((subject) => ({
      番号: subject.key,
      内容: subject.text,
      ...(subject.context ? { 店舗名: subject.context } : {}),
    })),
  };
}

/** ask が要るのは systemOne だけ。テストから差し替えられるように、この形で受ける */
export type AskClient = Pick<TypeSafeClient, 'systemOne'>;

/**
 * 1 段ぶんの質問を投げて、答えを集める。
 *
 * 束は同時に投げる。直列にすると、明細を一気に取り込んだとき（`MAX_SUBJECTS` で 5 束）に
 * 1 段で 5 往復ぶん待つことになり、2 段で 10 往復。1 往復の最悪が
 * `timeout × (maxRetries + 1)` なので、Lambda の制限時間（30 秒）に収まらなくなる。
 * 同時に投げれば 1 段の待ち時間は 1 往復ぶんで済む。
 *
 * 束が 1 つ落ちても、その束の質問が未分類に落ちるだけで残りは活きる。
 * 全部落ちたときだけ投げ直して、502 として外に出す（判定できなかったことを黙らせない）。
 */
export async function ask(
  client: AskClient,
  state: Record<string, JsonValue>,
  specs: ChoiceSpec[],
): Promise<Record<string, ChoiceAnswer | undefined>> {
  const batches: ChoiceSpec[][] = [];
  for (let start = 0; start < specs.length; start += QUESTIONS_PER_REQUEST) {
    batches.push(specs.slice(start, start + QUESTIONS_PER_REQUEST));
  }
  if (batches.length === 0) return {};

  const settled = await Promise.allSettled(
    batches.map((batch) => {
      const questions: Record<string, ChoiceQuestion> = Object.fromEntries(
        batch.map((spec) => [spec.name, choice(spec.instructions, spec.criteria)]),
      );
      return client.systemOne({ state, questions });
    }),
  );

  const answers: Record<string, ChoiceAnswer | undefined> = {};
  const failures: unknown[] = [];
  for (const result of settled) {
    if (result.status === 'fulfilled') Object.assign(answers, toAnswers(result.value.answers));
    else failures.push(result.reason);
  }

  if (failures.length > 0) {
    console.warn('[classify] 束が落ちました', {
      落ちた数: failures.length,
      束の数: batches.length,
      理由: describeFailure(failures[0]),
    });
  }
  if (failures.length === batches.length) throw failures[0];

  return answers;
}

/**
 * 落ちた理由をログに残す形にする。例外をそのまま console に渡さないのは、
 * 何が入っているかが外の SDK の都合で決まるため。型の上では応答側（status・
 * ヘッダ・本文）しか持っていないが、ここは鍵を読んだクライアントの例外なので、
 * 要るものだけ取り出す方に倒す。
 */
export function describeFailure(cause: unknown): string {
  if (!(cause instanceof Error)) return '不明な失敗';
  const status = (cause as { status?: unknown }).status;
  return typeof status === 'number' ? `${cause.name}(${status}): ${cause.message}` : `${cause.name}: ${cause.message}`;
}

/**
 * Jev の答えから、判定に使う分（選んだラベルと確信度）だけを取り出す。
 * 形が違うものは捨てる。捨てた質問は未分類に落ちる。
 */
export function toAnswers(raw: unknown): Record<string, ChoiceAnswer> {
  if (typeof raw !== 'object' || raw === null) return {};

  const answers: Record<string, ChoiceAnswer> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue;
    const answer = value as { choice?: unknown; confidence?: unknown };
    if (typeof answer.choice !== 'string' || answer.choice === '') continue;
    if (typeof answer.confidence !== 'number' || !Number.isFinite(answer.confidence)) continue;
    answers[name] = { choice: answer.choice, confidence: Math.min(Math.max(answer.confidence, 0), 1) };
  }
  return answers;
}

/**
 * 鍵は 1 度だけ読んで、暖まったコンテナでは作り直さない。
 * 失敗したときはキャッシュを捨てる。残すと、鍵を入れ直しても次の呼び出しまで直らない。
 */
let client: Promise<TypeSafeClient> | undefined;

function clientOnce(): Promise<TypeSafeClient> {
  client ??= buildClient().catch((cause: unknown) => {
    client = undefined;
    throw cause;
  });
  return client;
}

async function buildClient(): Promise<TypeSafeClient> {
  const secret = await secrets.send(new GetSecretValueCommand({ SecretId: SECRET_ID }));
  const apiKey = (secret.SecretString ?? '').trim();
  if (apiKey === '') throw new Error(`カテゴリ判定の API キーが未設定です（${SECRET_ID}）`);

  return new TypeSafeClient({
    apiKey,
    defaultModel: MODEL_ID,
    /*
     * Jev は 1 秒を切って返る。待ち続けるより、待たせずに諦めてキーワード表に落とす方がいい。
     *
     * 1 往復の最悪は timeout × (maxRetries + 1) + 待ち時間で、ここでは 10 秒強。
     * 判定は 2 段あるので最悪 21 秒ほどになり、Lambda の制限時間（30 秒）の内側に収まる。
     * この 3 つ（timeout・maxRetries・関数の timeout）は連動しているので、
     * 片方だけ動かさないこと。
     */
    timeout: 5_000,
    retry: { maxRetries: 1 },
    // debug にするとリクエストの本文とヘッダが CloudWatch に出る。鍵が載る
    logLevel: 'warn',
  });
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parseBody(body: string | undefined, isBase64Encoded: boolean | undefined): Record<string, unknown> {
  if (!body) return {};
  const text = isBase64Encoded ? Buffer.from(body, 'base64').toString('utf-8') : body;
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function json(statusCode: number, payload: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload),
  };
}
