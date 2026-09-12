import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

export interface GithubOidcStackProps extends cdk.StackProps {
  /** 信頼する GitHub リポジトリ（owner/repo 形式） */
  repository: string;
}

/**
 * GitHub Actions から CDK デプロイするための OIDC 連携。
 *
 * アクセスキーをリポジトリに置かず、GitHub の OIDC トークンで一時認証する。
 * 作りは sakekasu-builder の同名スタックに倣った。
 *
 * 違いが 2 つある。
 *
 * 1. OIDC プロバイダーを作らず、既にあるものを参照する。
 *    1 つの AWS アカウントに同じ URL のプロバイダーは 1 つしか置けず、
 *    token.actions.githubusercontent.com のものは sakekasu-builder の
 *    `sakekasu-github-oidc` スタックが持っている。ここで作ろうとすると
 *    EntityAlreadyExists でデプロイが落ちる
 * 2. diff 用のロールを作っていない。PR に `cdk diff` を出すワークフローを
 *    まだ持っていないため。作るときに足す
 *
 * このスタックは Actions のデプロイ対象（`--all`）に含めない。
 * 自分自身のロールを自動更新して締め出す事故を避けるため、コンテキストフラグ付きの
 * 手動デプロイとする。
 * 使用例: npx cdk deploy sakekasu-kakeibo-github-oidc -c github-oidc=true
 */
export class GithubOidcStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: GithubOidcStackProps) {
    super(scope, id, props);

    const githubDomain = 'token.actions.githubusercontent.com';

    const provider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      'GithubOidcProvider',
      `arn:${this.partition}:iam::${this.account}:oidc-provider/${githubDomain}`,
    );

    const deployRole = new iam.Role(this, 'DeployRole', {
      roleName: 'sakekasu-kakeibo-github-actions-deploy',
      // IAM の description は ASCII + Latin-1 のみ。日本語を入れるとデプロイが 400 で落ちる
      description: 'CDK deploy from GitHub Actions (main branch only)',
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: {
          [`${githubDomain}:aud`]: 'sts.amazonaws.com',
          // main への push と、main から起動した workflow_dispatch だけがこの sub になる
          [`${githubDomain}:sub`]: `repo:${props.repository}:ref:refs/heads/main`,
        },
      }),
    });

    /*
     * 実際に作成・変更する権限はこのロールに持たせず、CDK bootstrap が作った
     * cdk-hnb659fds-* ロールへの AssumeRole だけを許可する。
     * ロール名にリージョンが入るのでワイルドカードで、ap-northeast-1 と
     * us-east-1（証明書の -cert スタック用）の両方を通す。
     */
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AssumeCdkBootstrapRoles',
        actions: ['sts:AssumeRole'],
        resources: [`arn:${this.partition}:iam::${this.account}:role/cdk-hnb659fds-*`],
      }),
    );

    // ワークフローがスタックの出力（API の URL、UserPool の ID、配信先）を読む
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadStackOutputs',
        actions: ['cloudformation:DescribeStacks'],
        resources: [`arn:${this.partition}:cloudformation:*:${this.account}:stack/sakekasu-kakeibo-*/*`],
      }),
    );

    /*
     * フロントの配信物の同期。CDK の BucketDeployment を使わず Actions から
     * `aws s3 sync` で置く方針（design.md）なので、この権限はロール側に要る。
     * バケット名は sakekasu-kakeibo-{env}-site-{account} で、環境名だけが変わる。
     */
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SyncSiteBucket',
        actions: ['s3:ListBucket', 's3:GetObject', 's3:PutObject', 's3:DeleteObject'],
        resources: [
          `arn:${this.partition}:s3:::sakekasu-kakeibo-*-site-${this.account}`,
          `arn:${this.partition}:s3:::sakekasu-kakeibo-*-site-${this.account}/*`,
        ],
      }),
    );

    /*
     * index.html の無効化。ディストリビューション ID はこのスタックを作る時点では
     * 決まっていないため、アカウント内の配信全体を対象にしている。
     * 無効化はキャッシュを捨てるだけで、配信物や設定を変えられる操作ではない。
     */
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'InvalidateDistribution',
        actions: ['cloudfront:CreateInvalidation'],
        resources: [`arn:${this.partition}:cloudfront::${this.account}:distribution/*`],
      }),
    );

    new cdk.CfnOutput(this, 'DeployRoleArn', { value: deployRole.roleArn });
  }
}
