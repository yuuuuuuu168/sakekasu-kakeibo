import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * cdkd 用ロールに付けるガードレール（Deny だけの inline ポリシー）。
 *
 * 4 アプリ（reinvent、builder、kakeibo、learning）と共通基盤は同じアカウントに同居していて、
 * cdkd 用ロールは AdministratorAccess を持つ。cdkd が誤った差分を出したとき（2026-10-04 には
 * タグを足しただけでロールの作り直しが起き、古いロールのポリシーが剥がされた）に、
 * 壊れるのをこのアプリの中に留めるのが目的。
 *
 * 悪意のある main の変更は止められない。deploy ロールは CDK bootstrap の cfn-exec ロール
 * （AdministratorAccess）を引き受けられ、このポリシー自体も deploy ワークフローが入れ直す。
 * 防ぎたいのは事故のほう。
 *
 * - 他のアプリの App タグが付いたリソースには触れない（読み取りも含めて拒否する）
 * - 他のアプリの App タグを付けない（このアプリの値以外のタグを付けて作る・付け替える）
 * - IAM ロールは App タグを付けていない（理由は bin/app.ts）ので、名前の接頭辞で絞る
 * - GitHub Actions のロール自身は書き換えない（接頭辞の範囲に入ってしまうため、別に止める）
 * - IAM ユーザー・アクセスキー・ID プロバイダー、Organizations、アカウント設定、
 *   CloudTrail の停止には触れない。どのアプリのデプロイにも要らない
 * - cdkd の状態バケットそのものと、他のアプリの状態を消したり書き換えたりしない
 *
 * App タグを条件にした Deny は、aws:ResourceTag を評価しない API（S3 のオブジェクト操作など）
 * には効かない。状態バケットのオブジェクトは名前で別に止めている。
 */
export interface DeployGuardrailProps {
  /** デプロイ先のアカウント ID */
  account: string;
  /** このアプリの App タグの値 */
  app: string;
  /** このアプリが作る IAM ロールと管理ポリシーの名前の接頭辞（スタック名の接頭辞） */
  resourceNamePrefix: string;
  /** 書き換えさせない GitHub Actions のロールの名前 */
  protectedRoleNames: string[];
}

/**
 * 状態バケット（`cdkd/<スタック名>/<リージョン>/state.json`）にある他のアプリのスタック名。
 * アプリやスタックを足したらここにも足す。このアプリの分は呼び出し側の接頭辞で除く
 */
export const CDKD_STACK_NAME_PATTERNS: Record<string, string[]> = {
  builder: ['sakekasu-dev-*', 'sakekasu-staging-*', 'sakekasu-prod-*'],
  integrated: ['sakekasu-integrated-*'],
  kakeibo: ['sakekasu-kakeibo-*'],
  learning: ['sakekasu-learning-*'],
  reinvent: ['ReinventPlanner*'],
};

/** IAM ロールを作り替える操作。ロールにはタグが無いので、名前で範囲を絞る */
const ROLE_WRITE_ACTIONS = [
  'iam:CreateRole',
  'iam:DeleteRole',
  'iam:UpdateRole',
  'iam:UpdateRoleDescription',
  'iam:UpdateAssumeRolePolicy',
  'iam:PutRolePolicy',
  'iam:DeleteRolePolicy',
  'iam:AttachRolePolicy',
  'iam:DetachRolePolicy',
  'iam:PutRolePermissionsBoundary',
  'iam:DeleteRolePermissionsBoundary',
  'iam:TagRole',
  'iam:UntagRole',
  'iam:PassRole',
  'iam:CreatePolicy',
  'iam:CreatePolicyVersion',
  'iam:DeletePolicy',
  'iam:DeletePolicyVersion',
  'iam:SetDefaultPolicyVersion',
];

export function deployGuardrailStatements(props: DeployGuardrailProps): iam.PolicyStatement[] {
  const { account, app, resourceNamePrefix, protectedRoleNames } = props;
  const stateBucket = `arn:aws:s3:::cdkd-state-${account}`;
  const otherStacks = Object.entries(CDKD_STACK_NAME_PATTERNS)
    .filter(([name]) => name !== app)
    .flatMap(([, patterns]) => patterns);

  return [
    new iam.PolicyStatement({
      sid: 'DenyOtherAppsResources',
      effect: iam.Effect.DENY,
      actions: ['*'],
      resources: ['*'],
      conditions: {
        Null: { 'aws:ResourceTag/App': 'false' },
        StringNotEquals: { 'aws:ResourceTag/App': app },
      },
    }),
    new iam.PolicyStatement({
      sid: 'DenyForeignAppTag',
      effect: iam.Effect.DENY,
      actions: ['*'],
      resources: ['*'],
      conditions: {
        Null: { 'aws:RequestTag/App': 'false' },
        StringNotEquals: { 'aws:RequestTag/App': app },
      },
    }),
    new iam.PolicyStatement({
      sid: 'DenyRolesOutsideApp',
      effect: iam.Effect.DENY,
      actions: ROLE_WRITE_ACTIONS,
      notResources: [
        `arn:aws:iam::${account}:role/${resourceNamePrefix}*`,
        `arn:aws:iam::${account}:policy/${resourceNamePrefix}*`,
      ],
    }),
    new iam.PolicyStatement({
      sid: 'DenyTamperingWithGithubActionsRoles',
      effect: iam.Effect.DENY,
      // 読み取り（Get / List）は通す
      actions: ['iam:Create*', 'iam:Delete*', 'iam:Update*', 'iam:Put*', 'iam:Attach*', 'iam:Detach*', 'iam:Tag*', 'iam:Untag*'],
      resources: protectedRoleNames.map((name) => `arn:aws:iam::${account}:role/${name}`),
    }),
    new iam.PolicyStatement({
      sid: 'DenyIdentityAndAccountControl',
      effect: iam.Effect.DENY,
      actions: [
        'iam:*User*',
        'iam:*AccessKey*',
        'iam:*LoginProfile*',
        'iam:*Group*',
        'iam:*OpenIDConnectProvider*',
        'iam:*SAMLProvider*',
        'iam:*ServiceSpecificCredential*',
        'iam:*SSHPublicKey*',
        'iam:*AccountPasswordPolicy',
        'iam:*AccountAlias',
        'organizations:*',
        'account:*',
        'sso:*',
        'identitystore:*',
        'cloudtrail:DeleteTrail',
        'cloudtrail:StopLogging',
        'cloudtrail:UpdateTrail',
        'cloudtrail:PutEventSelectors',
      ],
      resources: ['*'],
    }),
    new iam.PolicyStatement({
      sid: 'DenyChangingCdkdStateBucket',
      effect: iam.Effect.DENY,
      actions: [
        's3:DeleteBucket',
        's3:PutBucketPolicy',
        's3:DeleteBucketPolicy',
        's3:PutBucketAcl',
        's3:PutBucketVersioning',
        's3:PutLifecycleConfiguration',
        's3:PutBucketOwnershipControls',
        's3:PutBucketPublicAccessBlock',
        's3:PutEncryptionConfiguration',
      ],
      resources: [stateBucket],
    }),
    new iam.PolicyStatement({
      sid: 'DenyWritingOtherAppsState',
      effect: iam.Effect.DENY,
      actions: ['s3:PutObject', 's3:DeleteObject', 's3:DeleteObjectVersion'],
      resources: otherStacks.map((pattern) => `${stateBucket}/cdkd/${pattern}`),
    }),
  ];
}
