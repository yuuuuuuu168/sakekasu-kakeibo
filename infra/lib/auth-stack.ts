import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import type { Construct } from 'constructs';

export interface AuthStackProps extends cdk.StackProps {
  envName: string;
}

/**
 * 旧ユーザープール（このアプリ専用）。
 *
 * ログインは 4 アプリ共通のユーザープール（sakekasu-integrated_environment）へ移した。
 * このスタックは切り戻しとデータの付け替え（旧 sub を調べる）のためだけに残してあり、
 * API も画面ももう参照しない。データを移し終えたら別の PR で外す。手順は docs/operations.md の
 * 「共通ログインへの切り替え」にある。
 *
 * 利用者は本人ひとり。セルフサインアップは閉じ、ユーザーは手で 1 つ作る。
 * 家計簿に他人が登録できる経路を残す理由が無いため。
 */
export class AuthStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `sakekasu-kakeibo-${props.envName}`,
      selfSignUpEnabled: false,
      signInAliases: { email: true, username: true },
      /*
       * MFA は必須。二要素は認証アプリ（TOTP）だけで、SMS は使わない。SMS は電話番号を
       * 預かることになり、SIM の乗っ取りでも抜かれる。
       *
       * 共通ログインへ移ったので、画面はもうこのプールでサインインしない
       * （src/features/auth/AuthGate.tsx はマネージドログインへ送るだけになった）。
       */
      mfa: cognito.Mfa.REQUIRED,
      mfaSecondFactor: { sms: false, otp: true },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.userPoolClient = this.userPool.addClient('WebClient', {
      userPoolClientName: 'web',
      generateSecret: false,
      authFlows: { userSrp: true },
      preventUserExistenceErrors: true,
      accessTokenValidity: cdk.Duration.hours(8),
      idTokenValidity: cdk.Duration.hours(8),
      refreshTokenValidity: cdk.Duration.days(30),
    });

    /*
     * API スタックが参照していたころの export を、同じ名前のまま出し続ける。
     * 参照を外した回のデプロイで export まで消えると、使う側と出す側のどちらが先に
     * 更新されるかで失敗しうる（CloudFormation の「使用中の export は消せない」と同じ問題）。
     * このスタックの中身を一切変えずに済ませるためでもある。スタックを外す PR で一緒に消す。
     */
    this.exportValue(this.userPool.userPoolId);
    this.exportValue(this.userPoolClient.userPoolClientId);

    new cdk.CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: this.userPoolClient.userPoolClientId });
  }
}
