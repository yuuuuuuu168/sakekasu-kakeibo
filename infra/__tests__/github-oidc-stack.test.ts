import { describe, expect, it } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { GithubOidcStack } from '../lib/github-oidc-stack';

const ACCOUNT = '123456789012';
const REPOSITORY = 'yuuuuuuu168/sakekasu-kakeibo';

function template() {
  const app = new cdk.App();
  const stack = new GithubOidcStack(app, 'test-oidc', {
    repository: REPOSITORY,
    env: { account: ACCOUNT, region: 'ap-northeast-1' },
  });
  return Template.fromStack(stack);
}

describe('GithubOidcStack', () => {
  it('OIDC プロバイダーを作らない（sakekasu-builder のものを参照する）', () => {
    // 1 アカウントに同じ URL のプロバイダーは 1 つだけ。作ると EntityAlreadyExists で落ちる
    expect(Object.keys(template().findResources('Custom::AWSCDKOpenIdConnectProvider'))).toHaveLength(0);
    expect(Object.keys(template().findResources('AWS::IAM::OIDCProvider'))).toHaveLength(0);
  });

  it('audience を固定し、sub は 2 つの形式を許す', () => {
    template().hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'sakekasu-kakeibo-github-actions-deploy',
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Action: 'sts:AssumeRoleWithWebIdentity',
            Condition: {
              StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
              StringLike: {
                'token.actions.githubusercontent.com:sub': [
                  `repo:${REPOSITORY.replace('/', '@*/')}@*:ref:refs/heads/main`,
                  `repo:${REPOSITORY}:ref:refs/heads/main`,
                ],
              },
            },
          }),
        ],
      },
    });
  });

  /**
   * 実測した sub（2026-09-12、main への push）が通ることを、IAM と同じ
   * ワイルドカードの解釈で確かめる。旧形式だけを決め打ちしていたために
   * assume が延々と Not authorized で落ちたので、ここを回帰として残す。
   */
  describe('sub の照合', () => {
    const OBSERVED = 'repo:yuuuuuuu168@173623628/sakekasu-kakeibo@1367094471:ref:refs/heads/main';
    const LEGACY = 'repo:yuuuuuuu168/sakekasu-kakeibo:ref:refs/heads/main';

    function patterns(): string[] {
      const role = Object.values(template().findResources('AWS::IAM::Role'))[0];
      return role.Properties.AssumeRolePolicyDocument.Statement[0].Condition.StringLike[
        'token.actions.githubusercontent.com:sub'
      ] as string[];
    }

    /** IAM のワイルドカードは * が任意の文字列、? が 1 文字 */
    function matchesAny(subject: string): boolean {
      return patterns().some((pattern) => {
        const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
        return regex.test(subject);
      });
    }

    it('数値 ID 付きの実測値が通る', () => {
      expect(matchesAny(OBSERVED)).toBe(true);
    });

    it('ID の付かない旧形式も通る', () => {
      expect(matchesAny(LEGACY)).toBe(true);
    });

    it.each([
      ['別のブランチ', 'repo:yuuuuuuu168@173623628/sakekasu-kakeibo@1367094471:ref:refs/heads/develop'],
      ['プルリクエスト', 'repo:yuuuuuuu168@173623628/sakekasu-kakeibo@1367094471:pull_request'],
      ['別のリポジトリ', 'repo:yuuuuuuu168@173623628/sakekasu-builder@999:ref:refs/heads/main'],
      ['似た名前のオーナー', 'repo:yuuuuuuu1689@999/sakekasu-kakeibo@1367094471:ref:refs/heads/main'],
      ['別のオーナー', 'repo:someone@1/sakekasu-kakeibo@2:ref:refs/heads/main'],
      ['環境経由', 'repo:yuuuuuuu168@173623628/sakekasu-kakeibo@1367094471:environment:dev'],
    ])('%s は通らない', (_label, subject) => {
      expect(matchesAny(subject)).toBe(false);
    });
  });

  it('作成・変更の権限は持たず、bootstrap ロールへの AssumeRole だけを許す', () => {
    const statements = statementsOf(template());
    const assume = statements.find((s) => s.Sid === 'AssumeCdkBootstrapRoles');
    expect(assume).toBeDefined();
    expect(actionsOf(assume!)).toEqual(['sts:AssumeRole']);
    expect(JSON.stringify(assume!.Resource)).toContain(`role/cdk-hnb659fds-*`);
  });

  it('配信の同期と無効化だけを許し、どこにもワイルドカードの全許可を置かない', () => {
    const statements = statementsOf(template());
    const sids = statements.map((s) => s.Sid).sort();
    expect(sids).toEqual(['AssumeCdkBootstrapRoles', 'InvalidateDistribution', 'ReadStackOutputs', 'SyncSiteBucket']);

    for (const statement of statements) {
      const actions = actionsOf(statement);
      expect(actions).not.toContain('*');
      expect(actions.some((action) => String(action).endsWith(':*'))).toBe(false);
    }

    const sync = statements.find((s) => s.Sid === 'SyncSiteBucket')!;
    expect(JSON.stringify(sync.Resource)).toContain('sakekasu-kakeibo-*-site-');
    expect(actionsOf(sync)).not.toContain('s3:PutBucketPolicy');
  });

  it('CloudFormation は読み取りだけで、家計簿のスタックに限る', () => {
    const read = statementsOf(template()).find((s) => s.Sid === 'ReadStackOutputs')!;
    expect(actionsOf(read)).toEqual(['cloudformation:DescribeStacks']);
    expect(JSON.stringify(read.Resource)).toContain('stack/sakekasu-kakeibo-*/*');
  });
});

type Statement = { Sid?: string; Action: string | string[]; Resource: unknown };

/** CloudFormation は 1 要素の Action を文字列に畳むので、いつも配列で見る */
function actionsOf(statement: Statement): string[] {
  return [statement.Action].flat();
}

function statementsOf(t: Template): Statement[] {
  return Object.values(t.findResources('AWS::IAM::Policy')).flatMap(
    (policy) => policy.Properties.PolicyDocument.Statement as Statement[],
  );
}
