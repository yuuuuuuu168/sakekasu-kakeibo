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

  it('許可は AdministratorAccess の管理ポリシーだけで、インラインのポリシーは Deny だけ', () => {
    const role = Object.values(template().findResources('AWS::IAM::Role'))[0];
    expect(JSON.stringify(role.Properties.ManagedPolicyArns)).toContain(':iam::aws:policy/AdministratorAccess');
    expect(role.Properties.ManagedPolicyArns).toHaveLength(1);
    const policies = Object.values(template().findResources('AWS::IAM::Policy'));
    expect(policies).toHaveLength(1);
    const statements = policies[0].Properties.PolicyDocument.Statement as { Effect: string }[];
    expect(statements.every((s) => s.Effect === 'Deny')).toBe(true);
  });

  describe('ガードレール', () => {
    function statement(sid: string) {
      const policy = Object.values(template().findResources('AWS::IAM::Policy'))[0];
      const found = (policy.Properties.PolicyDocument.Statement as { Sid: string }[]).find((s) => s.Sid === sid);
      expect(found, sid).toBeDefined();
      return found as Record<string, unknown>;
    }

    it('他のアプリの App タグが付いたリソースと、他のアプリの App タグの付与を拒否する', () => {
      expect(statement('DenyOtherAppsResources').Condition).toEqual({
        Null: { 'aws:ResourceTag/App': 'false' },
        StringNotEquals: { 'aws:ResourceTag/App': 'kakeibo' },
      });
      expect(statement('DenyForeignAppTag').Condition).toEqual({
        Null: { 'aws:RequestTag/App': 'false' },
        StringNotEquals: { 'aws:RequestTag/App': 'kakeibo' },
      });
    });

    it('IAM ロールはこのアプリの接頭辞の外では作り替えられない', () => {
      expect(statement('DenyRolesOutsideApp').NotResource).toEqual([
        `arn:aws:iam::${ACCOUNT}:role/sakekasu-kakeibo-*`,
        `arn:aws:iam::${ACCOUNT}:policy/sakekasu-kakeibo-*`,
      ]);
    });

    it('接頭辞の範囲に入る GitHub Actions のロールは別に守る', () => {
      expect(statement('DenyTamperingWithGithubActionsRoles').Resource).toEqual([
        `arn:aws:iam::${ACCOUNT}:role/sakekasu-kakeibo-github-actions-cdkd`,
        `arn:aws:iam::${ACCOUNT}:role/sakekasu-kakeibo-github-actions-deploy`,
      ]);
    });

    it('他のアプリの cdkd の状態は書き換えられず、自分の状態は書ける', () => {
      const resources = statement('DenyWritingOtherAppsState').Resource as string[];
      const state = `arn:aws:s3:::cdkd-state-${ACCOUNT}/cdkd/`;
      expect(resources).toContain(`${state}sakekasu-learning*`);
      expect(resources).toContain(`${state}ReinventPlanner*`);
      expect(resources).toContain(`${state}sakekasu-dev*`);
      expect(resources).toContain(`${state}sakekasu-integrated*`);
      expect(resources.some((r) => r.includes('kakeibo'))).toBe(false);
    });
  });
});
