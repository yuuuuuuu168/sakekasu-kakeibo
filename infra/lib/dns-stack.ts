import * as cdk from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import type { Construct } from 'constructs';

export interface DnsStackProps extends cdk.StackProps {
  /** このアカウントで持つゾーンの名前。例: kakeibo.sakekasu-builder.com */
  zoneName: string;
}

/**
 * 配信に使うサブドメインのゾーン。
 *
 * 親の sakekasu-builder.com のゾーンは別のアカウントにあり、CloudFormation は
 * そこにレコードを書けない。そこでサブドメインのゾーンをこのアカウントに置き、
 * 親から委任してもらう。委任が済めばこの配下はこのアカウントで完結し、証明書の
 * DNS 検証もエイリアスレコードも CDK が面倒を見られる。
 *
 * ゾーンだけを別のスタックにしてあるのは、順番を守らないと詰まるため。
 *
 *   1. このスタックを作る（NS 4 つが決まる）
 *   2. 親のゾーン側に、そのサブドメインの NS レコードを 1 つ入れる（別アカウントでの手作業）
 *   3. dig NS で委任が効いたことを確かめる
 *   4. cdk.json に domainName と、このスタックが出した HostedZoneId を書く
 *
 * 3 を飛ばして 4 に進むと、証明書の DNS 検証が通らず deploy が終わらない。
 * 検証レコードは書き込まれるが、誰も引かないゾーンに入るため ACM は永久に
 * PENDING_VALIDATION のままになる。実際に一度これで 45 分止めた。
 *
 * ゾーンは消えない設定にしてある。作り直すと NS が変わり、親側の委任も
 * 入れ直しになる（別アカウントでの手作業がもう一度必要になる）。
 */
export class DnsStack extends cdk.Stack {
  public readonly zone: route53.PublicHostedZone;

  constructor(scope: Construct, id: string, props: DnsStackProps) {
    super(scope, id, props);

    this.zone = new route53.PublicHostedZone(this, 'Zone', {
      zoneName: props.zoneName,
      comment: 'sakekasu-kakeibo の配信に使う。親から委任されている',
    });
    this.zone.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    new cdk.CfnOutput(this, 'HostedZoneId', {
      value: this.zone.hostedZoneId,
      description: 'cdk.json の hostedZoneId に書く値',
    });

    // 親のゾーンに入れる NS レコードの中身。手で写すのでまとめて出す
    new cdk.CfnOutput(this, 'NameServers', {
      value: cdk.Fn.join(' ', this.zone.hostedZoneNameServers ?? []),
      description: '親のゾーンに NS レコードとして入れる 4 つ',
    });
  }
}
