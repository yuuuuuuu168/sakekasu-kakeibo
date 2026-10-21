import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/*
 * デプロイしたときに「作り直し」になる部分を固定するテスト。
 *
 * cdkd は論理 ID が変わったリソースを別物とみなし、新しく作って古いものを消す。ロールは
 * プロパティを変えただけでも作り直すことがある（docs/aws-infra-rules.md の 7）。作り直しの最中は
 * Lambda が消えたロールを指して止まり、テーブルやバケットなら中身が消える。stacks.test.ts は
 * 部分一致で探すので、こうした変化を見逃す。
 *
 * そこで本番と同じ合成（cdk.json の context、スタック名 sakekasu-kakeibo-dev-*）を走らせ、
 * 次のものだけを取り出してスナップショットにする。
 *
 * - 全リソースの論理 ID と型（論理 ID が変われば作り直し）
 * - ロールの Properties 全体（信頼ポリシー・管理ポリシー・境界）と、cdkd が導くロール名
 * - リソースの名前（ロール名・関数名・テーブル名・バケット名・SLO の名前など。変われば作り直し）
 * - データを持つリソースの DeletionPolicy / UpdateReplacePolicy（外れると消える）
 *
 * 落ちたら、差分が意図したものかを見る。意図した変更なら `npx vitest run -u __tests__/identity.test.ts`
 * で更新し、PR に「作り直しになるリソース」として書く。ロールの差分は、実物のロール名が cdkd の
 * 導く名前と一致するかを先に確かめる（aws-infra-rules の 7）。
 */

const INFRA = resolve(__dirname, '..');
const STACKS = ['dns', 'data', 'api', 'site'].map((name) => `sakekasu-kakeibo-dev-${name}`);

/** 名前を持つプロパティ。変えると作り直しになる */
const NAME_KEYS = [
  'RoleName',
  'FunctionName',
  'TableName',
  'BucketName',
  'LogGroupName',
  'Name',
  'AlarmName',
  'RuleName',
] as const;

/** 中身を持つリソース。保持の設定が外れると、作り直しや削除で中身が消える */
const DATA_TYPES = new Set([
  'AWS::DynamoDB::GlobalTable',
  'AWS::DynamoDB::Table',
  'AWS::S3::Bucket',
  'AWS::SecretsManager::Secret',
  'AWS::Logs::LogGroup',
  'AWS::Route53::HostedZone',
  'AWS::ApplicationSignals::ServiceLevelObjective',
]);

type Resource = {
  Type: string;
  Properties?: Record<string, unknown>;
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
};

let out: string;
const templates = new Map<string, { Resources: Record<string, Resource> }>();

beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), 'kakeibo-identity-'));
  // 公開リポジトリなので、アカウントはテスト用の値で合成する（aws-infra-rules の 9）
  execFileSync('npx', ['cdk', 'synth', '--quiet', '--output', out], {
    cwd: INFRA,
    env: { ...process.env, CDK_DEFAULT_ACCOUNT: '123456789012', CDK_DEFAULT_REGION: 'ap-northeast-1' },
    stdio: 'pipe',
  });
  for (const file of readdirSync(out).filter((name) => name.endsWith('.template.json'))) {
    templates.set(file.replace('.template.json', ''), JSON.parse(readFileSync(join(out, file), 'utf8')));
  }
}, 180_000);

afterAll(() => {
  if (out) rmSync(out, { recursive: true, force: true });
});

/**
 * cdkd 0.294.7 が RoleName の無いロールに導く名前（aws-infra-rules の 7）。
 * `<スタック名>-<論理 ID>` の英数字とハイフン以外を `-` にし、64 文字を超えたら
 * 先頭 55 文字に `-` と元の文字列の sha256 の先頭 8 文字を足す
 */
export function cdkdRoleName(stackName: string, logicalId: string): string {
  const raw = `${stackName}-${logicalId}`;
  const name = raw.replace(/[^A-Za-z0-9-]/g, '-');
  if (name.length <= 64) return name;
  return `${name.slice(0, 55)}-${createHash('sha256').update(raw).digest('hex').slice(0, 8)}`;
}

function identityOf(stackName: string) {
  const template = templates.get(stackName);
  if (!template) throw new Error(`${stackName} が合成されていない`);

  const resources: Record<string, string> = {};
  const roles: Record<string, { cdkdName: string; properties: unknown }> = {};
  const names: Record<string, Record<string, unknown>> = {};
  const retention: Record<string, { DeletionPolicy?: string; UpdateReplacePolicy?: string }> = {};

  for (const [id, resource] of Object.entries(template.Resources).sort(([a], [b]) => a.localeCompare(b))) {
    if (resource.Type === 'AWS::CDK::Metadata') continue;
    resources[id] = resource.Type;

    const properties = resource.Properties ?? {};
    if (resource.Type === 'AWS::IAM::Role') {
      roles[id] = {
        cdkdName: typeof properties.RoleName === 'string' ? properties.RoleName : cdkdRoleName(stackName, id),
        properties,
      };
    }

    const named = Object.fromEntries(NAME_KEYS.filter((key) => key in properties).map((key) => [key, properties[key]]));
    if (Object.keys(named).length > 0) names[id] = named;

    if (DATA_TYPES.has(resource.Type)) {
      retention[id] = {
        ...(resource.DeletionPolicy ? { DeletionPolicy: resource.DeletionPolicy } : {}),
        ...(resource.UpdateReplacePolicy ? { UpdateReplacePolicy: resource.UpdateReplacePolicy } : {}),
      };
    }
  }

  return { resources, roles, names, retention };
}

describe('作り直しになる部分（本番と同じ合成）', () => {
  it('アプリ本体のスタックがそろっている', () => {
    expect([...templates.keys()].sort()).toEqual([...STACKS].sort());
  });

  for (const stackName of STACKS) {
    it(`${stackName} の論理 ID・ロール・名前・保持の設定が変わっていない`, () => {
      expect(identityOf(stackName)).toMatchSnapshot();
    });
  }

  /*
   * CloudFormation の頃に作ったロール。実物の名前は CloudFormation の命名（ランダムな接尾辞つき）のままで、
   * cdkd の導く名前と一致しないと考えられる。RoleName を書き足すと名前が変わって作り直しになり、
   * 書かないままでもプロパティを変えれば作り直しになる。どちらも aws-infra-rules の 7 を読んでから触る
   */
  it('CloudFormation の頃に作ったロールは名前を書いていない', () => {
    const resources = templates.get('sakekasu-kakeibo-dev-api')!.Resources;
    const legacy = Object.entries(resources).filter(
      ([id, resource]) => resource.Type === 'AWS::IAM::Role' && /^(Api|Classify|MonthlyReport)FunctionServiceRole/.test(id),
    );
    expect(legacy.map(([id]) => id.replace(/[0-9A-F]{8}$/, '')).sort()).toEqual([
      'ApiFunctionServiceRole',
      'ClassifyFunctionServiceRole',
      'MonthlyReportFunctionServiceRole',
    ]);
    expect(legacy.every(([, role]) => role.Properties?.RoleName === undefined)).toBe(true);
  });
});

describe('cdkdRoleName', () => {
  it('64 文字以内ならそのまま、記号はハイフンにする', () => {
    expect(cdkdRoleName('sakekasu-kakeibo-dev-api', 'ApiFunctionServiceRole52B9747B')).toBe(
      'sakekasu-kakeibo-dev-api-ApiFunctionServiceRole52B9747B',
    );
    expect(cdkdRoleName('a_b', 'C.D')).toBe('a-b-C-D');
  });

  it('64 文字を超えたら先頭 55 文字に sha256 の先頭 8 文字を足す', () => {
    const name = cdkdRoleName('sakekasu-kakeibo-dev-api', 'MonthlyReportFunctionServiceRole516D5A15');
    expect(name).toHaveLength(64);
    expect(name.slice(0, 55)).toBe('sakekasu-kakeibo-dev-api-MonthlyReportFunctionServiceRo');
    expect(name).toMatch(/-[0-9a-f]{8}$/);
  });
});
