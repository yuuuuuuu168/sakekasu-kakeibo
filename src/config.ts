/**
 * 設定はビルド時に Vite の環境変数から入る。GitHub Actions が CDK の出力を渡す。
 * 何も渡されていなければ「ローカルモード」で動き、データはブラウザの localStorage に入る。
 * AWS を用意する前でも `npm run dev` で試せるようにしてあるのは、
 * カテゴリの試行錯誤フェーズを手元で始められるようにするため。
 */
export type AppConfig = {
  mode: 'local' | 'remote';
  apiUrl: string;
  userPoolId: string;
  userPoolClientId: string;
};

const apiUrl = (import.meta.env.VITE_API_URL as string | undefined) ?? '';
const userPoolId = (import.meta.env.VITE_USER_POOL_ID as string | undefined) ?? '';
const userPoolClientId = (import.meta.env.VITE_USER_POOL_CLIENT_ID as string | undefined) ?? '';

export const config: AppConfig = {
  mode: apiUrl && userPoolId && userPoolClientId ? 'remote' : 'local',
  apiUrl,
  userPoolId,
  userPoolClientId,
};
