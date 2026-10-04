import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import { deployGuardrailStatements } from './deploy-guardrail';
import { githubMainBranchPrincipal } from './github-principal';

export interface CdkdDeployStackProps extends cdk.StackProps {
  /** 信頼する GitHub リポジトリ（owner/repo 形式） */
  repository: string;
}

/** cdkd でデプロイするときに GitHub Actions が引き受けるロールの名前 */
export const CDKD_DEPLOY_ROLE_NAME = 'sakekasu-kakeibo-github-actions-cdkd';

/** github-oidc スタックの deploy ロールの名前。cdkd 用ロールから書き換えさせない */
export const GITHUB_DEPLOY_ROLE_NAME = 'sakekasu-kakeibo-github-actions-deploy';

/**
 * アプリ本体を cdkd でデプロイするためのロール。
 *
 * cdkd は CloudFormation を通さず、各サービスの API を呼び出し元の権限で直接叩く。
 * CDK bootstrap の cdk-hnb659fds-* ロールは CloudFormation に権限を委ねる前提の作りで、
 * cdkd からは使えない。そこで別のロールを置く。
 *
 * 権限は AdministratorAccess にしている。cdkd が触るのは IAM・Lambda・DynamoDB・Cognito・
 * CloudFront・API Gateway・Route53・ACM・EventBridge・Logs・S3・SSM と、自身の状態の
 * S3 バケットにまたがり、足りない権限はデプロイの途中で落ちて初めて分かる。
 * 一方で、main の Actions は CloudFormation 経由で cdk-hnb659fds-cfn-exec-role
 * （bootstrap の既定で AdministratorAccess）を既に使えていた。このロールを足しても、
 * main から届く権限の上限は変わらない。
 *
 * 信頼条件は deploy ロールと同じで、main ブランチの Actions だけが引き受けられる。
 *
 * このスタック自身は CloudFormation（`cdk deploy`）で入れる。cdkd に自分の権限の出どころを
 * 管理させると、壊したときに直す手段が無くなるため。deploy ワークフローが毎回
 * deploy ロールで `cdk deploy -c cdkd-deploy=true` を打つので、手で打つ必要は無い。
 * github-oidc と違って、ここを壊しても deploy ロールは無傷で残り、次の push で直せる。
 *
 * 管理者権限の上から、他のアプリのリソースに触れないためのガードレール（Deny）を重ねる。
 * 中身と、何を防げて何を防げないかは deploy-guardrail.ts にある。
 */
export class CdkdDeployStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: CdkdDeployStackProps) {
    super(scope, id, props);

    const role = new iam.Role(this, 'CdkdDeployRole', {
      roleName: CDKD_DEPLOY_ROLE_NAME,
      // IAM の description は ASCII + Latin-1 のみ。日本語を入れるとデプロイが 400 で落ちる
      description: 'cdkd deploy from GitHub Actions (main branch only)',
      assumedBy: githubMainBranchPrincipal(this, props.repository),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess')],
    });

    new iam.Policy(this, 'Guardrail', {
      policyName: 'deploy-guardrail',
      roles: [role],
      statements: deployGuardrailStatements({
        account: this.account,
        app: 'kakeibo',
        resourceNamePrefix: 'sakekasu-kakeibo-',
        protectedRoleNames: [CDKD_DEPLOY_ROLE_NAME, GITHUB_DEPLOY_ROLE_NAME],
      }),
    });

    new cdk.CfnOutput(this, 'CdkdDeployRoleArn', { value: role.roleArn });
  }
}
