import * as path from 'node:path';
import * as url from 'node:url';
import type * as cdk from 'aws-cdk-lib';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, type BundlingOptions, type NodejsFunctionProps } from 'aws-cdk-lib/aws-lambda-nodejs';
import type * as logs from 'aws-cdk-lib/aws-logs';
import { lambdaLogGroup } from './log-group';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..', '..');

/**
 * AWS SDK も含めて 1 ファイルに固める。
 * Node.js の実行環境にも SDK v3 は入っているが、どのパッケージがどの版で入るかは
 * AWS 側の都合で変わる。家計簿が黙って動かなくなる経路を残したくないので、
 * 使うものは全部こちらで持つ。関数あたり数 MB 増えるだけで、実害は無い。
 */
const BUNDLING: BundlingOptions = { externalModules: [], target: 'node22', minify: true, sourceMap: false };

export type AppFunctionProps = Omit<
  NodejsFunctionProps,
  'functionName' | 'entry' | 'handler' | 'runtime' | 'architecture' | 'depsLockFilePath' | 'bundling' | 'logGroup'
> & {
  /** スタックの接頭辞（`sakekasu-kakeibo-{env}`）。関数名は `${prefix}-${key}` になる */
  prefix: string;
  /** 関数の名前の後半で、コードの置き場所でもある（`infra/lambda/${key}/index.ts`） */
  key: string;
  /**
   * ロググループ。ほかで使う（アラームでログの行を数える）ときは先に作って渡す。
   * 渡さなければ、logsId の論理 ID で作る
   */
  logGroup?: logs.ILogGroup;
  /** logGroup を渡さないときに作るロググループの論理 ID */
  logsId?: string;
};

/**
 * アプリの Lambda。5 つの関数で同じだった設定（実行環境、アーキテクチャ、バンドル、ロググループ）をまとめる。
 *
 * Construct で包まず、渡されたスコープ（スタック）の直下に作る。包むと論理 ID の道筋が変わり、
 * 関数とロールが作り直しになる（docs/aws-infra-rules.md の 7）。論理 ID は呼び出し側が渡した `id` のまま
 */
export function appFunction(scope: cdk.Stack, id: string, props: AppFunctionProps): { fn: NodejsFunction; functionName: string } {
  const { prefix, key, logGroup, logsId, ...rest } = props;
  const functionName = `${prefix}-${key}`;
  if (!logGroup && !logsId) throw new Error(`${id}: logGroup か logsId のどちらかが要る`);

  const fn = new NodejsFunction(scope, id, {
    ...rest,
    functionName,
    entry: path.join(repoRoot, `infra/lambda/${key}/index.ts`),
    handler: 'handler',
    runtime: Runtime.NODEJS_22_X,
    architecture: Architecture.ARM_64,
    depsLockFilePath: path.join(repoRoot, 'package-lock.json'),
    bundling: BUNDLING,
    logGroup: logGroup ?? lambdaLogGroup(scope, logsId!, functionName),
  });
  return { fn, functionName };
}
