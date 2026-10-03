/**
 * 設定はビルド時に Vite の環境変数から入る。GitHub Actions が CDK の出力を渡す。
 * 何も渡されていなければ「ローカルモード」で動き、データはブラウザの localStorage に入る。
 * AWS を用意する前でも `npm run dev` で試せるようにしてあるのは、
 * カテゴリの試行錯誤フェーズを手元で始められるようにするため。
 *
 * ログインは 4 アプリ共通のユーザープール（sakekasu-integrated_environment）の
 * マネージドログイン（authDomain）へリダイレクトして行う。値は infra/cdk.json の sharedAuth が出どころ。
 */
export type AppConfig = {
  mode: 'local' | 'remote';
  apiUrl: string;
  userPoolId: string;
  userPoolClientId: string;
  /** マネージドログインのドメイン（https:// を付けない。例: auth.sakekasu-builder.com） */
  authDomain: string;
};

const apiUrl = (import.meta.env.VITE_API_URL as string | undefined) ?? '';
const userPoolId = (import.meta.env.VITE_USER_POOL_ID as string | undefined) ?? '';
const userPoolClientId = (import.meta.env.VITE_USER_POOL_CLIENT_ID as string | undefined) ?? '';
const authDomain = (import.meta.env.VITE_AUTH_DOMAIN as string | undefined) ?? '';

export const config: AppConfig = {
  mode: apiUrl && userPoolId && userPoolClientId && authDomain ? 'remote' : 'local',
  apiUrl,
  userPoolId,
  userPoolClientId,
  authDomain,
};
