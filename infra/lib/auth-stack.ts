import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import type { Construct } from 'constructs';

export interface AuthStackProps extends cdk.StackProps {
  envName: string;
}

/**
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
       * 必須にすると、登録していないユーザーはサインインの途中で登録の段に入る。
       * 画面側（src/features/auth/AuthGate.tsx）がその段を扱えないと、サインインする
       * 手段が無くなる。両方を揃えて変えること。
       *
       * 端末を失くしたときは管理者が admin-set-user-mfa-preference で解除して
       * 登録し直す。手順は docs/operations.md にある。
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

    new cdk.CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: this.userPoolClient.userPoolClientId });
  }
}
