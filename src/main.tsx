import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Amplify } from 'aws-amplify';
// マネージドログインから戻ったとき（?code=...）に、認可コードをトークンへ換える処理を有効にする
import 'aws-amplify/auth/enable-oauth-listener';
import { App } from './App';
import { config } from './config';
import './index.css';

if (config.mode === 'remote') {
  /*
   * 戻り先は登録済みの URL と末尾の / まで完全一致させる（https://kakeibo.sakekasu-builder.com/ と
   * http://localhost:5173/）。画面の遷移はハッシュなので、戻り先は常にルートでよい。
   * スコープは共通ログインが許している 3 つだけ。aws.cognito.signin.user.admin は無いので、
   * fetchUserAttributes や MFA・パスワードの変更など、それが要る API は使えない。
   */
  const origin = `${window.location.origin}/`;
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: config.userPoolId,
        userPoolClientId: config.userPoolClientId,
        loginWith: {
          oauth: {
            domain: config.authDomain,
            scopes: ['openid', 'email', 'profile'],
            redirectSignIn: [origin],
            redirectSignOut: [origin],
            responseType: 'code',
          },
        },
      },
    },
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
