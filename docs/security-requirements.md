# セキュリティレビューの観点

PR のセキュリティレビューで見てほしい観点。`.github/workflows/claude-review.yml` が Claude に
このファイルを読ませている（リポジトリを公開してからは、AWS Security Agent のコードレビューが
PR にコメントを付けられないため）。

元は AWS Security Agent のコンソール（Agent Space → セキュリティ要件）に入れる内容として書いた。
マネージドの要件（認証・認可、監視、暗号化、シークレット管理、情報保護）は有効にしたうえで、
このリポジトリ固有のものをカスタム要件として足す。

コンソールに貼るときは 1 つずつ独立した要件として入れる。以下はその原文。

## 1. 明細とレシートは利用者ごとに閉じていること

API の全ての読み書きが Cognito の JWT の `sub` でスコープされていること。
`infra/lambda/api/index.ts` は `sub` を DynamoDB のパーティションキー（`USER#${sub}`）に使って
読み書きを閉じている。リクエストの本文やパスから来た値でパーティションを跨げてはならない。
`sub` が空や文字列以外のときは 401 で止まること。

## 2. レシート画像の置き場所が推測や指定で他人のものに届かないこと

S3 のキーは `receipts/${sub}/...` の形で、利用者が指定した文字列をそのままキーに入れないこと。
`createUpload` が返す署名付き URL は PUT だけ、期限は 300 秒。期限を伸ばさないこと、
GET や他の操作まで署名しないこと。受け取る `contentType` は `image/` から始まるものに限ること。

## 3. 配信物のバケットを直接読ませないこと

レシート画像と配信物のバケットはパブリックアクセスを塞ぎ、CloudFront（OAC）越しにだけ読ませること。

## 4. Bedrock の権限を推論プロファイルと振り先の 2 つに限ること

`infra/lib/api-stack.ts` の IAM は、推論プロファイルと振り先の foundation-model の
2 つの ARN だけを許している。`*` に広げないこと、別のアクションを足さないこと。
Lambda ごとの権限も同じで、API は table への読み書きとバケットへの `Put` だけ、
OCR はバケットの読み取りと Bedrock、読み取りジョブの行（パーティションキーが `OCR#` で始まる行）の
`UpdateItem`、それに Claude API に入るための `sts:GetWebIdentityToken` だけ、
カテゴリ判定は API キーのシークレットの読み取りだけに限ること。

`sts:GetWebIdentityToken` は条件で、宛先（`sts:IdentityTokenAudience`）を `https://api.anthropic.com`、
寿命（`sts:DurationSeconds`）を 300 秒以下、署名（`sts:SigningAlgorithm`）を RS256 に絞っている。
条件を外さないこと。外すと、このロールで別の外部サービスに入るためのトークンも作れてしまう。
OCR のロールの名前（`sakekasu-kakeibo-{env}-ocr-receipt`）は Claude Console のフェデレーションルールが
照合しているので、ルールの照合を `role/*` のような前方一致に広げないこと。
API が OCR の関数を非同期で呼ぶための `lambda:InvokeFunction` は、その関数 1 つに限ること。

## 5. カテゴリ判定の API キーをコードにもテンプレートにも置かないこと

カテゴリ判定（TypeSafe / Jev）の鍵は Secrets Manager の
`sakekasu-kakeibo-{env}-typesafe-api-key` に入れ、値は人が入れる。
CDK が作るのは入れ物だけで、`generateSecretString` 以外で値を渡さないこと。
環境変数に鍵そのものを置かないこと（関数に渡すのはシークレットの ARN）。
Lambda のログに鍵が出ないこと（SDK の `logLevel` を `debug` にしないこと。
`debug` はリクエストヘッダと本文を出す）。

API の Lambda は、保存した明細とレシートの中身（金額・日付・品目名・店舗名・カテゴリ）を
1 リクエスト 1 行でログに出す（`describeRequest`）。何がどのカテゴリで保存されたかを
CloudWatch で追うためで、利用者が出してよいと決めた。Cognito の `sub` と、
リクエストヘッダ（トークン）は出さないこと。

## 6. 外部のモデルへ渡すのはレシートの写真と、品目名・店舗名だけに限ること

レシートの OCR（`infra/lambda/ocr-receipt/`）は、写真を Anthropic の Claude API（`api.anthropic.com`）に送る
（利用者が 2026-10 に認めた）。送るのは写真と読み方の指示文だけで、Cognito の `sub`、明細、
ほかのレシートの中身を足さないこと。Claude API で失敗したときは Bedrock で読み直す。
Claude API には API キーではなく Workload Identity Federation で入り、鍵をどこにも置かないこと。

カテゴリ判定（`infra/lambda/classify/`）が TypeSafe に送るのは、レシートの品目名と明細の店舗名、
そしてカテゴリの一覧（ID と名前）だけ。レシート画像、金額、日付、明細の件数や合計、
Cognito の `sub` を送らないこと。1 回の呼び出しで見る対象の上限（`MAX_SUBJECTS`）を
外さないこと。判定が落ちても処理が続くこと（キーワード表とルールに落ちる）。

## 7. デプロイ用ロールを main 以外から引き受けられないこと

`infra/lib/github-oidc-stack.ts` の信頼ポリシーは main の ref のときだけ引き受けを許している。
PR や他のブランチ、他のリポジトリから引き受けられるようにしないこと。

## 8. CloudFront のセキュリティヘッダを緩めないこと

CSP、HSTS、`X-Content-Type-Options` ほかを `infra/lib/site-stack.ts` で付けている。
特に CSP に `unsafe-inline` や `unsafe-eval`、広いホストを足さないこと。

## 9. 外から来たファイルの解析で境界を越えないこと

CSV / PDF / 画像の取り込みは `packages/core/src/statement/` と `src/features/import/`。
文字コード判定や列の推定で際限なくメモリを使わないこと。解析した値を検査せずに
DOM や API の呼び出しへ渡さないこと。明細やレシートの文字列を画面に出すのに
`dangerouslySetInnerHTML` のような経路を使わないこと。

## 10. Actions のワークフローで認証情報を依存のコードに触らせないこと

`deploy.yml` は AWS の認証を入れる前に `npm ci --ignore-scripts` を済ませる並びになっている。
この順番を崩さないこと。`permissions` を広げないこと、`pull_request_target` を使わないこと、
PR のタイトルや本文、ブランチ名を `run:` の中へ直接展開しないこと。

## 指摘が要らないもの

誤検知が続いたら、この節の内容を要件の書き方に反映するか、コンソール側で対象から外す。

- `src/api/local.ts` と画面のローカルモード。AWS を使わずに手元で動かすための実装で、
  データはブラウザの中にしか無い。「保存先が安全でない」は当たらない
- テストのフィクスチャに入っているダミーの明細・口座番号・アカウント ID（`000000000000` など）
- 叱りレポートの文面テンプレート（固定文字列を組み立てているだけ）
- 利用者が本人ひとりの前提で作ってあるので、複数利用者の権限管理（ロール、共有、招待）が
  無いこと自体は当たらない。見るのは、既にある `sub` による分離が崩れていないかのほう
