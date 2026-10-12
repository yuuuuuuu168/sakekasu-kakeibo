import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import { SHARED_BUCKET_WRITE_ACTIONS } from './deploy-guardrail';

/**
 * アプリのロール（Lambda の実行ロールなど）に付ける Permissions Boundary。
 * 作りは sakekasu-builder と sakekasu-integrated_environment の role-boundary.ts に倣った。
 *
 * cdkd 用ロールは接頭辞 `sakekasu-kakeibo-` のロールを作り替えられる。名前で閉じても、
 *
 *   1. `iam:PutRolePolicy` で Lambda の実行ロールに管理者相当を書き込む
 *   2. その関数のコードを差し替えて呼ぶ
 *
 * の 2 手で、cdkd 用ロールのガードレール（deploy-guardrail.ts）の外の操作に届く。
 * 境界を付けると、ロールの実効権限は「ロール自身のポリシー ∩ 境界」になるので、
 * 1 で何を書き込まれても境界の外には出られない。
 *
 * 中身は「全部許して、昇格と他のアプリに届くものだけ抜く」形。境界は許可を与えないので、
 * 天井を `*` にしてもアプリの権限は増えない。アプリのロールはどれも IAM を使わず、STS は
 * Claude API の ID 連携に使う GetWebIdentityToken だけを呼ぶ。他のアプリのリソースにも、
 * cdkd の状態や資産置き場にも触れない。
 * 他のアプリのリソースを使う処理を足すと、デプロイは通っても実行時に AccessDenied になる。
 */
export const ROLE_BOUNDARY_NAME = 'sakekasu-kakeibo-role-boundary';

/** このアプリの App タグの値 */
const APP = 'kakeibo';

/** 指定アカウントでの境界ポリシーの ARN */
export function roleBoundaryArn(account: string): string {
  return `arn:aws:iam::${account}:policy/${ROLE_BOUNDARY_NAME}`;
}

/**
 * 境界ポリシーの本体を作る。`CdkdDeployStack`（CloudFormation で入れるスタック）からだけ呼ぶ。
 *
 * アプリのスタックより先に存在している必要がある。deploy ワークフローは cdkd-deploy の
 * スタックを cdkd より先に入れるので、この順序は保たれる。
 */
export function createRoleBoundary(scope: Construct, id: string): iam.ManagedPolicy {
  const { account } = cdk.Stack.of(scope);
  const stateBucket = `arn:aws:s3:::cdkd-state-${account}`;

  return new iam.ManagedPolicy(scope, id, {
    managedPolicyName: ROLE_BOUNDARY_NAME,
    // IAM の description は ASCII + Latin-1 のみ
    description: 'Ceiling for sakekasu-kakeibo app roles created by cdkd',
    statements: [
      new iam.PolicyStatement({
        sid: 'AllowUpToTheCeiling',
        actions: ['*'],
        resources: ['*'],
      }),
      new iam.PolicyStatement({
        sid: 'DenyIdentityAndAccountControl',
        effect: iam.Effect.DENY,
        actions: [
          'iam:*',
          // sts:* にはしない。Claude API の ID 連携（api-stack.ts）が sts:GetWebIdentityToken を呼ぶ。
          // 取れるのは外部のサービス向けの ID トークンで、AWS の権限は増えない。宛先と寿命はロール側の条件で絞ってある
          'sts:AssumeRole*',
          'sts:GetFederationToken',
          'sts:GetSessionToken',
          'organizations:*',
          'account:*',
          'sso:*',
          'sso-directory:*',
          'identitystore:*',
          'cloudtrail:Delete*',
          'cloudtrail:Stop*',
          'cloudtrail:Update*',
          'cloudtrail:Put*',
        ],
        resources: ['*'],
      }),
      // cdkd 用ロールのガードレールと同じ条件
      new iam.PolicyStatement({
        sid: 'DenyOtherAppsResources',
        effect: iam.Effect.DENY,
        actions: ['*'],
        resources: ['*'],
        conditions: {
          Null: { 'aws:ResourceTag/App': 'false' },
          StringNotEquals: { 'aws:ResourceTag/App': APP },
        },
      }),
      new iam.PolicyStatement({
        sid: 'DenyForeignAppTag',
        effect: iam.Effect.DENY,
        actions: ['*'],
        resources: ['*'],
        conditions: {
          Null: { 'aws:RequestTag/App': 'false' },
          StringNotEquals: { 'aws:RequestTag/App': APP },
        },
      }),
      // cdkd の状態は全アプリ分が 1 つのバケットにある。アプリのロールは読みもしない
      new iam.PolicyStatement({
        sid: 'DenyCdkdState',
        effect: iam.Effect.DENY,
        actions: ['s3:*'],
        resources: [stateBucket, `${stateBucket}/*`],
      }),
      // 資産置き場は CDK の BucketDeployment が読むことがあるので、書き込みと削除だけ止める
      new iam.PolicyStatement({
        sid: 'DenyWritingSharedAssets',
        effect: iam.Effect.DENY,
        actions: ['s3:PutObject', 's3:DeleteObject', 's3:DeleteObjectVersion', ...SHARED_BUCKET_WRITE_ACTIONS],
        resources: [`arn:aws:s3:::cdkd-assets-${account}-*`, `arn:aws:s3:::cdk-hnb659fds-assets-${account}-*`],
      }),
    ],
  });
}

/**
 * スタック内で作られるロールすべてに境界を付ける。CDK が裏で作るロールにも効く。
 *
 * GitHub Actions のロールのスタック（github-oidc、cdkd-deploy）には付けない。
 * cdkd 用ロール自身に付くと iam:* が拒否され、アプリのロールを作れなくなる。
 */
export function applyRoleBoundary(stack: cdk.Stack): void {
  const boundary = iam.ManagedPolicy.fromManagedPolicyName(stack, 'RoleBoundary', ROLE_BOUNDARY_NAME);
  iam.PermissionsBoundary.of(stack).apply(boundary);
}
