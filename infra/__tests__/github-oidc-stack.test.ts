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

  it('main への push からしか引き受けられない', () => {
    template().hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'sakekasu-kakeibo-github-actions-deploy',
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Action: 'sts:AssumeRoleWithWebIdentity',
            Condition: {
              StringEquals: {
                'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
                'token.actions.githubusercontent.com:sub': `repo:${REPOSITORY}:ref:refs/heads/main`,
              },
            },
          }),
        ],
      },
    });
  });

  it('別のリポジトリや別のブランチを信頼しない', () => {
    const trust = JSON.stringify(
      Object.values(template().findResources('AWS::IAM::Role'))[0].Properties.AssumeRolePolicyDocument,
    );
    expect(trust).toContain('repo:yuuuuuuu168/sakekasu-kakeibo:ref:refs/heads/main');
    expect(trust).not.toContain('sakekasu-builder');
    expect(trust).not.toContain('pull_request');
    expect(trust).not.toContain('ref:refs/heads/*');
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
