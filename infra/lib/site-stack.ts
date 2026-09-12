import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

export interface SiteStackProps extends cdk.StackProps {
  envName: string;
  /** kakeibo.sakekasu-builder.com。未指定なら CloudFront の既定ドメインで配信する */
  domainName?: string;
  /** us-east-1 の証明書。domainName を使うなら必要 */
  certificateArn?: string;
  hostedZoneId?: string;
  zoneName?: string;
  /** CSP の connect-src に入れる API の URL */
  apiUrl: string;
  /** CSP の connect-src に入れるレシート用バケットのドメイン */
  receiptBucketDomain: string;
  cognitoRegion: string;
}

/**
 * フロントの配信。S3 に置いて CloudFront から OAC で読む。
 *
 * sakekasu-builder は Amplify Hosting だが、あちらの docs/amplify-exit.md が
 * 「配信設定だけが IaC の外にある」ことを唯一の移行動機に挙げている。
 * 新しく作るものを同じ状態から始める理由が無いので、最初から CDK に載せる。
 *
 * 配信物は GitHub Actions から `aws s3 sync` で置く。CDK の BucketDeployment は
 * 使わない（カスタムリソースが増え、CloudFormation から IMPORT できなくなる）。
 */
export class SiteStack extends cdk.Stack {
  public readonly bucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: SiteStackProps) {
    super(scope, id, props);

    this.bucket = new s3.Bucket(this, 'SiteBucket', {
      bucketName: `sakekasu-kakeibo-${props.envName}-site-${this.account}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    /**
     * セキュリティヘッダ。sakekasu-builder が Amplify のコンソールに持っている 7 種を
     * そのまま持ってきたうえで、script-src の 'unsafe-inline' と 'unsafe-eval' は外した。
     * Vite の出力に inline script も eval も無いので要らない。
     * style-src の 'unsafe-inline' は残す。React が style 属性を直接付ける箇所がある。
     */
    const csp = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self'",
      "img-src 'self' data: blob:",
      "worker-src 'self' blob:",
      `connect-src 'self' ${props.apiUrl} https://${props.receiptBucketDomain} https://cognito-idp.${props.cognitoRegion}.amazonaws.com`,
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "object-src 'none'",
    ].join('; ');

    const responseHeaders = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      responseHeadersPolicyName: `sakekasu-kakeibo-${props.envName}-headers`,
      securityHeadersBehavior: {
        strictTransportSecurity: {
          accessControlMaxAge: cdk.Duration.days(365),
          includeSubdomains: true,
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
        xssProtection: { protection: true, modeBlock: true, override: true },
        contentSecurityPolicy: { contentSecurityPolicy: csp, override: true },
      },
      customHeadersBehavior: {
        customHeaders: [
          { header: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()', override: true },
        ],
      },
    });

    const useCustomDomain = Boolean(props.domainName && props.certificateArn);

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `sakekasu-kakeibo ${props.envName}`,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: responseHeaders,
        compress: true,
      },
      defaultRootObject: 'index.html',
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      // 独自ドメインが無いときは CloudFront の既定証明書が使われ、この指定は効かない
      ...(useCustomDomain ? { minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021 } : {}),
      // 画面遷移はハッシュで済ませているので実質 index.html だけだが、
      // 直打ちや古い URL で 403/404 になったときも画面を出す
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: cdk.Duration.minutes(5) },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: cdk.Duration.minutes(5) },
      ],
      ...(useCustomDomain
        ? {
            domainNames: [props.domainName!],
            certificate: acm.Certificate.fromCertificateArn(this, 'Certificate', props.certificateArn!),
          }
        : {}),
    });

    if (useCustomDomain && props.hostedZoneId && props.zoneName) {
      const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
        hostedZoneId: props.hostedZoneId,
        zoneName: props.zoneName,
      });
      const target = route53.RecordTarget.fromAlias(new route53targets.CloudFrontTarget(this.distribution));
      new route53.ARecord(this, 'AliasA', { zone, recordName: props.domainName, target });
      new route53.AaaaRecord(this, 'AliasAAAA', { zone, recordName: props.domainName, target });
    }

    new cdk.CfnOutput(this, 'SiteBucketName', { value: this.bucket.bucketName });
    new cdk.CfnOutput(this, 'DistributionId', { value: this.distribution.distributionId });
    new cdk.CfnOutput(this, 'SiteUrl', {
      value: useCustomDomain ? `https://${props.domainName}` : `https://${this.distribution.distributionDomainName}`,
    });
  }
}
