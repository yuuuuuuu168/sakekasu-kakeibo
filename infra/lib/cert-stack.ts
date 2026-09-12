import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import type { Construct } from 'constructs';

export interface CertStackProps extends cdk.StackProps {
  domainName: string;
  hostedZoneId: string;
  zoneName: string;
}

/**
 * CloudFront に付ける証明書は us-east-1 にしか置けないので、スタックを分けてある。
 * Route53 にゾーンがある場合だけ合成される。ゾーンが別の DNS サービスにあるときは
 * 証明書を手で発行して、その ARN を context の certificateArn に渡す
 * （DNS 検証つきの証明書を CDK に作らせると、レコードが入るまで deploy が待ち続ける）。
 */
export class CertStack extends cdk.Stack {
  public readonly certificate: acm.ICertificate;

  constructor(scope: Construct, id: string, props: CertStackProps) {
    super(scope, id, props);

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
      hostedZoneId: props.hostedZoneId,
      zoneName: props.zoneName,
    });

    this.certificate = new acm.Certificate(this, 'Certificate', {
      domainName: props.domainName,
      validation: acm.CertificateValidation.fromDns(zone),
    });

    new cdk.CfnOutput(this, 'CertificateArn', { value: this.certificate.certificateArn });
  }
}
