#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ApiStack } from '../lib/api-stack';
import { CdkdDeployStack } from '../lib/cdkd-deploy-stack';
import { GithubOidcStack } from '../lib/github-oidc-stack';
import { CertStack } from '../lib/cert-stack';
import { DataStack } from '../lib/data-stack';
import { DnsStack } from '../lib/dns-stack';
import { SiteStack } from '../lib/site-stack';
import { parseSharedAuth, userPoolRegion } from '../lib/shared-auth';

const app = new cdk.App();

// 全リソースに App タグを付ける。アプリごとのコストを Cost Explorer で分けるため。
// デプロイ用ロールに「他のアプリのタグが付いたリソースには触れない」ガードレールを足す
// 予定で、その判定にもこのタグを使う。ガードレールはまだ無い（次の段で足す）ので、
// それまではタグを付けただけでは何も守られない。4 アプリと共通基盤が同じアカウントに
// 同居していて、名前の接頭辞では分けきれないためタグで見分ける。
//
// IAM ロールには付けない。CloudFormation から cdkd へ移したロールは物理名が CFN の命名のままで、
// cdkd はロールを更新するたびに名前が変わったとみなして作り直す（2026-10-04 にタグを足しただけで
// 作り直しが起き、Lambda が消えたロールを指して止まった）。ロールはガードレールでも
// 名前の接頭辞で範囲を絞る
cdk.Tags.of(app).add('App', 'kakeibo', { excludeResourceTypes: ['AWS::IAM::Role'] });

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
const REPOSITORY = 'yuuuuuuu168/sakekasu-kakeibo';

if (app.node.tryGetContext('github-oidc')) {
  new GithubOidcStack(app, 'sakekasu-kakeibo-github-oidc', { repository: REPOSITORY, env });
} else if (app.node.tryGetContext('cdkd-deploy')) {
  /*
   * アプリ本体を cdkd でデプロイするためのロール（環境に紐づかない単一のスタック）。
   *
   * これだけは CloudFormation で入れるので、cdkd の対象（`cdkd deploy --all`）に
   * 混ざらないよう、github-oidc と同じくフラグで切り分ける。deploy ワークフローが
   * cdkd を動かす前に毎回打つ。理由は cdkd-deploy-stack.ts にある。
   *
   * 使用例: npx cdk deploy sakekasu-kakeibo-cdkd-deploy -c cdkd-deploy=true
   */
  new CdkdDeployStack(app, 'sakekasu-kakeibo-cdkd-deploy', { repository: REPOSITORY, env });
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

  /*
   * 配信に使うサブドメインのゾーン。context の dnsZone を渡したときだけ作る。
   *
   * 親の sakekasu-builder.com のゾーンは別のアカウントにあり、CloudFormation は
   * そこにレコードを書けない。そこでサブドメインのゾーンをこちらに置いて委任してもらう。
   *
   * domainName とは別の鍵にしてある。ゾーンを作ってから親側に NS を入れるまでの間に
   * domainName が有効になると、証明書の DNS 検証が通らず deploy が終わらない。
   * 順番は docs/operations.md にある。
   */
  const dnsZone = app.node.tryGetContext('dnsZone') as string | undefined;
  if (dnsZone) {
    new DnsStack(app, `${prefix}-dns`, { zoneName: dnsZone, env });
  }

  /*
   * ログインは 4 アプリ共通のユーザープール（sakekasu-integrated_environment）を使う。
   * 値は cdk.json の context `sharedAuth` に書いてあり、スタックの参照ではつながない。
   */
  const sharedAuth = parseSharedAuth(app.node.tryGetContext('sharedAuth'));

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
    sharedAuth,
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
    cognitoRegion: userPoolRegion(sharedAuth.userPoolId),
    authDomain: sharedAuth.domain,
  });
}
