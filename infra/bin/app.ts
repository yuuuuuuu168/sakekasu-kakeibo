#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ApiStack } from '../lib/api-stack';
import { AuthStack } from '../lib/auth-stack';
import { GithubOidcStack } from '../lib/github-oidc-stack';
import { CertStack } from '../lib/cert-stack';
import { DataStack } from '../lib/data-stack';
import { SiteStack } from '../lib/site-stack';

const app = new cdk.App();

const REGION = 'ap-northeast-1';
const VALID_ENVS = ['dev', 'prod'] as const;

const envName = (app.node.tryGetContext('env') as string | undefined) ?? 'dev';
if (!VALID_ENVS.includes(envName as (typeof VALID_ENVS)[number])) {
  throw new Error(`環境名が無効です: "${envName}"。有効な値: ${VALID_ENVS.join(', ')}`);
}

const prefix = `sakekasu-kakeibo-${envName}`;
const account = process.env.CDK_DEFAULT_ACCOUNT;
const env: cdk.Environment = { account, region: REGION };

/*
 * GitHub Actions からデプロイするための OIDC 連携（環境に紐づかない単一のスタック）。
 *
 * Actions 自身にこのスタックを触らせると、ロールの更新ミスで自分を締め出す恐れがあるため、
 * フラグ付きの手動デプロイ専用にする。フラグが立っているときは**このスタックだけ**を
 * 合成して、アプリ本体を合成しない。同じ実行に混ぜると
 * `cdk deploy --all -c github-oidc=true` でロールまで巻き込めてしまう。
 *
 * 使用例: npx cdk deploy sakekasu-kakeibo-github-oidc -c github-oidc=true
 */
if (app.node.tryGetContext('github-oidc')) {
  new GithubOidcStack(app, 'sakekasu-kakeibo-github-oidc', {
    repository: 'yuuuuuuu168/sakekasu-kakeibo',
    env,
  });
} else {
  buildApplicationStacks();
}

/** アプリ本体のスタック群 */
function buildApplicationStacks(): void {
  /**
   * 配信するドメイン。cdk.json に既定値が入っている。
   *
   * 証明書の扱いは 3 通り。
   * 1. context に hostedZoneId と zoneName を渡す → us-east-1 の証明書を CDK が作り、DNS 検証も自動
   * 2. context に certificateArn を渡す → 既に発行済みの証明書を使う（DNS が Route53 に無い場合）
   * 3. どちらも渡さない → CloudFront の既定ドメインで配信する。後からドメインを足せる
   */
  const domainName = app.node.tryGetContext('domainName') as string | undefined;
  const hostedZoneId = app.node.tryGetContext('hostedZoneId') as string | undefined;
  const zoneName = (app.node.tryGetContext('zoneName') as string | undefined) ?? domainName?.split('.').slice(1).join('.');
  let certificateArn = app.node.tryGetContext('certificateArn') as string | undefined;

  const authStack = new AuthStack(app, `${prefix}-auth`, { envName, env });

  const dataStack = new DataStack(app, `${prefix}-data`, {
    envName,
    env,
    // OCR で品目を取り出した後の画像は残す意味が薄いので 90 日で消す
    receiptRetentionDays: 90,
  });

  /*
   * API の CORS で許す配信元。
   *
   * 独自ドメインを使っているときはそれを入れる。使っていないとき（CloudFront の
   * 既定ドメインで配信しているとき）は、その URL を context の siteOrigin で渡す。
   * 配信スタックを作る前にはディストリビューションのドメインが決まらないため、
   * 初回は API → 配信の順に作ってから siteOrigin を入れて 2 回目を打つ形になる。
   * この手順は docs/operations.md にある。
   */
  const siteOrigin = app.node.tryGetContext('siteOrigin') as string | undefined;
  const allowedOrigins = [
    ...(domainName ? [`https://${domainName}`] : []),
    ...(siteOrigin ? [siteOrigin] : []),
    'http://localhost:5173',
  ];

  const apiStack = new ApiStack(app, `${prefix}-api`, {
    envName,
    env,
    table: dataStack.table,
    receiptBucket: dataStack.receiptBucket,
    userPool: authStack.userPool,
    userPoolClient: authStack.userPoolClient,
    allowedOrigins,
  });

  if (!certificateArn && domainName && hostedZoneId && zoneName) {
    const certStack = new CertStack(app, `${prefix}-cert`, {
      domainName,
      hostedZoneId,
      zoneName,
      env: { account, region: 'us-east-1' },
      crossRegionReferences: true,
    });
    certificateArn = certStack.certificate.certificateArn;
  }

  new SiteStack(app, `${prefix}-site`, {
    envName,
    env,
    crossRegionReferences: true,
    ...(domainName ? { domainName } : {}),
    ...(certificateArn ? { certificateArn } : {}),
    ...(hostedZoneId ? { hostedZoneId } : {}),
    ...(zoneName ? { zoneName } : {}),
    apiUrl: apiStack.httpApi.apiEndpoint,
    receiptBucketDomain: dataStack.receiptBucket.bucketRegionalDomainName,
    cognitoRegion: REGION,
  });
}
