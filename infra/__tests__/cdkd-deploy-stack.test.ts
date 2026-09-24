import { describe, expect, it } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { CDKD_DEPLOY_ROLE_NAME, CdkdDeployStack } from '../lib/cdkd-deploy-stack';
import { GithubOidcStack } from '../lib/github-oidc-stack';

const ACCOUNT = '123456789012';
const REPOSITORY = 'yuuuuuuu168/sakekasu-kakeibo';
const env = { account: ACCOUNT, region: 'ap-northeast-1' };

function template() {
  const app = new cdk.App();
  return Template.fromStack(new CdkdDeployStack(app, 'test-cdkd', { repository: REPOSITORY, env }));
}

function trustOf(t: Template): unknown {
  const role = Object.values(t.findResources('AWS::IAM::Role'))[0];
  return role.Properties.AssumeRolePolicyDocument;
}

describe('CdkdDeployStack', () => {
  it('ワークフローが引き受ける名前でロールを作る', () => {
    template().hasResourceProperties('AWS::IAM::Role', { RoleName: CDKD_DEPLOY_ROLE_NAME });
    // deploy.yml の CDKD_ROLE と名前が食い違うと、assume が「ロールが無い」と同じ形で落ちる
    expect(CDKD_DEPLOY_ROLE_NAME).toBe('sakekasu-kakeibo-github-actions-cdkd');
  });

  it('OIDC プロバイダーを作らない（sakekasu-builder のものを参照する）', () => {
    expect(Object.keys(template().findResources('AWS::IAM::OIDCProvider'))).toHaveLength(0);
    expect(Object.keys(template().findResources('Custom::AWSCDKOpenIdConnectProvider'))).toHaveLength(0);
  });

  /*
   * 強い権限を持つロールなので、引き受けられる範囲は deploy ロールより広げない。
   * 信頼ポリシーをそのまま突き合わせ、main ブランチ以外に開いていないことを確かめる
   */
  it('信頼条件は deploy ロールと同じ（main ブランチの Actions だけ）', () => {
    const app = new cdk.App();
    const oidc = Template.fromStack(new GithubOidcStack(app, 'test-oidc', { repository: REPOSITORY, env }));
    expect(trustOf(template())).toEqual(trustOf(oidc));
    template().hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Action: 'sts:AssumeRoleWithWebIdentity',
            Condition: Match.objectLike({
              StringLike: {
                'token.actions.githubusercontent.com:sub': [
                  `repo:${REPOSITORY.replace('/', '@*/')}@*:ref:refs/heads/main`,
                  `repo:${REPOSITORY}:ref:refs/heads/main`,
                ],
              },
            }),
          }),
        ],
      },
    });
  });

  it('権限は AdministratorAccess の管理ポリシーだけで、インラインのポリシーを持たない', () => {
    const role = Object.values(template().findResources('AWS::IAM::Role'))[0];
    expect(JSON.stringify(role.Properties.ManagedPolicyArns)).toContain(':iam::aws:policy/AdministratorAccess');
    expect(role.Properties.ManagedPolicyArns).toHaveLength(1);
    expect(Object.keys(template().findResources('AWS::IAM::Policy'))).toHaveLength(0);
  });
});
