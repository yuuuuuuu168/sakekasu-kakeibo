import { describe, expect, it } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ApiStack } from '../lib/api-stack';
import { AuthStack } from '../lib/auth-stack';
import { DataStack } from '../lib/data-stack';
import { DnsStack } from '../lib/dns-stack';
import { SiteStack } from '../lib/site-stack';

const env = { account: '123456789012', region: 'ap-northeast-1' };

function stacks() {
  const app = new cdk.App();
  const auth = new AuthStack(app, 'test-auth', { envName: 'test', env });
  const data = new DataStack(app, 'test-data', { envName: 'test', env, receiptRetentionDays: 90 });
  const api = new ApiStack(app, 'test-api', {
    envName: 'test',
    env,
    table: data.table,
    receiptBucket: data.receiptBucket,
    userPool: auth.userPool,
    userPoolClient: auth.userPoolClient,
    allowedOrigins: ['https://kakeibo.sakekasu-builder.com'],
  });
  const site = new SiteStack(app, 'test-site', {
    envName: 'test',
    env,
    apiUrl: 'https://example.execute-api.ap-northeast-1.amazonaws.com',
    receiptBucketDomain: 'bucket.s3.ap-northeast-1.amazonaws.com',
    cognitoRegion: 'ap-northeast-1',
  });
  return { auth, data, api, site };
}

describe('AuthStack', () => {
  it('セルフサインアップを閉じている', () => {
    const template = Template.fromStack(stacks().auth);
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
    });
  });

  it('ブラウザ向けクライアントに SRP 以外の認証を持たせない', () => {
    const template = Template.fromStack(stacks().auth);
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ExplicitAuthFlows: Match.arrayWith(['ALLOW_USER_SRP_AUTH']),
      GenerateSecret: false,
    });
    const clients = template.findResources('AWS::Cognito::UserPoolClient');
    for (const client of Object.values(clients)) {
      expect(client.Properties.ExplicitAuthFlows).not.toContain('ALLOW_USER_PASSWORD_AUTH');
      expect(client.Properties.ExplicitAuthFlows).not.toContain('ALLOW_ADMIN_USER_PASSWORD_AUTH');
    }
  });
});

describe('DataStack', () => {
  it('レシートのバケットを公開しない', () => {
    const template = Template.fromStack(stacks().data);
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  it('レシート画像を 90 日で消す', () => {
    Template.fromStack(stacks().data).hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([Match.objectLike({ ExpirationInDays: 90, Status: 'Enabled' })]),
      },
    });
  });

  it('テーブルを消えない設定にし、ポイントインタイムリカバリを入れる', () => {
    const template = Template.fromStack(stacks().data);
    template.hasResource('AWS::DynamoDB::GlobalTable', { DeletionPolicy: 'Retain' });
    template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      Replicas: Match.arrayWith([
        Match.objectLike({ PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } }),
      ]),
    });
  });
});

describe('ApiStack', () => {
  it('すべての経路に Cognito の認可を付ける', () => {
    const template = Template.fromStack(stacks().api);
    template.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', { AuthorizerType: 'JWT' });
    const routes = template.findResources('AWS::ApiGatewayV2::Route');
    expect(Object.keys(routes).length).toBeGreaterThan(0);
    for (const route of Object.values(routes)) {
      expect(route.Properties.AuthorizationType).toBe('JWT');
    }
  });

  it('Bedrock は推論プロファイルと振り先の基盤モデルの両方を許可する', () => {
    const template = Template.fromStack(stacks().api);
    const policies = Object.values(template.findResources('AWS::IAM::Policy'));
    const statements = policies.flatMap((policy) => policy.Properties.PolicyDocument.Statement as Record<string, unknown>[]);
    const bedrock = statements.find((statement) => JSON.stringify(statement.Action).includes('bedrock:InvokeModel'));
    expect(bedrock).toBeDefined();

    // ARN は Fn::Join で組まれるので、文字列に直して見る
    const resources = JSON.stringify(bedrock!.Resource);
    expect(resources).toContain('inference-profile/jp.anthropic.claude-haiku');
    expect(resources).toContain('ap-northeast-1::foundation-model/anthropic.claude-haiku');
    expect(resources).toContain('ap-northeast-3::foundation-model/anthropic.claude-haiku');
  });

  it('OCR の同時実行に天井を置く', () => {
    Template.fromStack(stacks().api).hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'sakekasu-kakeibo-test-ocr-receipt',
      ReservedConcurrentExecutions: 3,
    });
  });

  it('CORS は渡した配信元だけを許す', () => {
    Template.fromStack(stacks().api).hasResourceProperties('AWS::ApiGatewayV2::Api', {
      CorsConfiguration: {
        AllowOrigins: ['https://kakeibo.sakekasu-builder.com'],
        AllowHeaders: ['authorization', 'content-type'],
      },
    });
  });

  /*
   * preflight が認証に掛かると、CORS が正しくてもブラウザは本体のリクエストを
   * 投げない。ANY を書くと OPTIONS まで拾ってしまうので、そうなっていないことを見る。
   */
  it('OPTIONS をルートに持たせない（preflight を API Gateway に任せる）', () => {
    const routes = Template.fromStack(stacks().api).findResources('AWS::ApiGatewayV2::Route');
    const keys = Object.values(routes).map((route) => route.Properties.RouteKey as string);

    expect(keys).toContain('GET /{proxy+}');
    expect(keys).toContain('POST /receipts/analyze');
    expect(keys.filter((key) => key.startsWith('OPTIONS ') || key.startsWith('ANY '))).toEqual([]);
  });

  it('毎月 1 日にレポートを作る', () => {
    Template.fromStack(stacks().api).hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'cron(0 0 1 * ? *)',
    });
  });

  it('カスタムリソースを作らない（ロググループは明示して作る）', () => {
    const template = Template.fromStack(stacks().api);
    expect(Object.keys(template.findResources('Custom::LogRetention'))).toHaveLength(0);
    template.resourceCountIs('AWS::Logs::LogGroup', 3);
  });
});

describe('DnsStack', () => {
  function dns() {
    return new DnsStack(new cdk.App(), 'test-dns', { zoneName: 'kakeibo.sakekasu-builder.com', env });
  }

  it('渡した名前の公開ゾーンを 1 つ作る', () => {
    const template = Template.fromStack(dns());
    template.resourceCountIs('AWS::Route53::HostedZone', 1);
    template.hasResourceProperties('AWS::Route53::HostedZone', {
      Name: 'kakeibo.sakekasu-builder.com.',
    });
  });

  /*
   * 作り直すと NS が変わり、親のゾーン側の委任も入れ直しになる。それは別アカウントでの
   * 手作業なので、消えない設定であることを見張る。
   */
  it('ゾーンを消えない設定にする', () => {
    Template.fromStack(dns()).hasResource('AWS::Route53::HostedZone', { DeletionPolicy: 'Retain' });
  });

  it('ゾーン ID と NS を出力する', () => {
    const outputs = Template.fromStack(dns()).findOutputs('*');
    expect(Object.keys(outputs).sort()).toEqual(['HostedZoneId', 'NameServers']);
  });
});

describe('SiteStack', () => {
  it('セキュリティヘッダを 7 種そろえる', () => {
    const template = Template.fromStack(stacks().site);
    template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: {
        SecurityHeadersConfig: {
          StrictTransportSecurity: { AccessControlMaxAgeSec: 31_536_000, IncludeSubdomains: true, Override: true },
          ContentTypeOptions: { Override: true },
          FrameOptions: { FrameOption: 'DENY', Override: true },
          ReferrerPolicy: { ReferrerPolicy: 'strict-origin-when-cross-origin', Override: true },
          XSSProtection: { ModeBlock: true, Protection: true, Override: true },
          ContentSecurityPolicy: { ContentSecurityPolicy: Match.stringLikeRegexp("default-src 'self'") },
        },
        CustomHeadersConfig: {
          Items: Match.arrayWith([Match.objectLike({ Header: 'Permissions-Policy' })]),
        },
      },
    });
  });

  it('script-src に unsafe-inline と unsafe-eval を入れない', () => {
    const template = Template.fromStack(stacks().site);
    const policies = template.findResources('AWS::CloudFront::ResponseHeadersPolicy');
    const csp = Object.values(policies)[0].Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig
      .ContentSecurityPolicy.ContentSecurityPolicy as string;
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('unsafe-eval');
    expect(csp.split(';').find((part) => part.includes('script-src'))).not.toContain('unsafe-inline');
  });

  it('403 と 404 を index.html の 200 に読み替える', () => {
    Template.fromStack(stacks().site).hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        CustomErrorResponses: Match.arrayWith([
          Match.objectLike({ ErrorCode: 403, ResponseCode: 200, ResponsePagePath: '/index.html' }),
          Match.objectLike({ ErrorCode: 404, ResponseCode: 200, ResponsePagePath: '/index.html' }),
        ]),
      },
    });
  });

  /**
   * ドメインを渡さない状態（CloudFront の既定ドメインで配信する状態）の確認。
   * `sakekasu-builder.com` の委任先ゾーンが別アカウントにあることが分かるまで、
   * この状態で運用する。詳細は docs/operations.md にある。
   */
  /*
   * サブドメイン委任なので、ゾーン名は配信するドメインそのもの。CDK は recordName が
   * ゾーン名で終わっていれば足さないが、二重になると kakeibo.kakeibo.… になって
   * 気づきにくいので見張る。
   */
  it('ドメインを渡せば別名とエイリアスレコードを付ける', () => {
    const app = new cdk.App();
    const site = new SiteStack(app, 'test-site-domain', {
      envName: 'test',
      env,
      domainName: 'kakeibo.sakekasu-builder.com',
      certificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/abc',
      hostedZoneId: 'Z0123456789ABCDEFGHIJ',
      zoneName: 'kakeibo.sakekasu-builder.com',
      apiUrl: 'https://example.execute-api.ap-northeast-1.amazonaws.com',
      receiptBucketDomain: 'bucket.s3.ap-northeast-1.amazonaws.com',
      cognitoRegion: 'ap-northeast-1',
    });
    const template = Template.fromStack(site);

    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({ Aliases: ['kakeibo.sakekasu-builder.com'] }),
    });

    const records = Object.values(template.findResources('AWS::Route53::RecordSet'));
    expect(records.map((record) => record.Properties.Type).sort()).toEqual(['A', 'AAAA']);
    for (const record of records) {
      expect(record.Properties.Name).toBe('kakeibo.sakekasu-builder.com.');
      expect(record.Properties.HostedZoneId).toBe('Z0123456789ABCDEFGHIJ');
    }
  });

  it('ドメインを渡さなければ別名も証明書も付けず、Route53 も触らない', () => {
    const template = Template.fromStack(stacks().site);
    const distribution = Object.values(template.findResources('AWS::CloudFront::Distribution'))[0];
    expect(distribution.Properties.DistributionConfig.Aliases).toBeUndefined();
    expect(distribution.Properties.DistributionConfig.ViewerCertificate).toBeUndefined();
    expect(Object.keys(template.findResources('AWS::Route53::RecordSet'))).toHaveLength(0);
  });

  it('配信物のバケットを公開せず、OAC で読む', () => {
    const template = Template.fromStack(stacks().site);
    template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, RestrictPublicBuckets: true },
    });
  });
});
