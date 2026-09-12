#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ApiStack } from '../lib/api-stack';
import { AuthStack } from '../lib/auth-stack';
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

const allowedOrigins = [...(domainName ? [`https://${domainName}`] : []), 'http://localhost:5173'];

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
