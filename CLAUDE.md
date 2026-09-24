# CLAUDE.md

sakekasu-kakeibo の開発の進め方。前提そのもの（何のアプリで、どう作ってあるか）は
[.kiro/steering/project-overview.md](.kiro/steering/project-overview.md) にあり、こちらは常に読み込まれる。

## Git / ブランチ運用

- 機能開発は必ず feature ブランチを作成してから作業する
- ブランチに初回 push したら、必ず PR も作成する（push だけで終わらせない）
- PR のレビュー・マージは人間様が行う。余は PR 作成まで

初版だけは人間様の指示で main へ直接 push した。以降はこの運用に従う。

### PR を作ったら watch する

PR を作成したら、ユーザーの指示を待たずにそのまま `subscribe_pr_activity` を呼び、
その PR の CI とレビューコメントを watch する。毎回「watch して」と言わせない。

- watch を始めたら、PR の URL とあわせて一行で報告する
- CI が落ちたら原因を調べて直し、同じブランチに push する。落ちた理由が自分の変更と
  無関係（base ブランチが赤い等）なら、その旨を PR に一度だけ書く
- レビューコメントは対応するか、対応しない理由を返す。黙って終わらせない
- watch はマージまたはクローズまで続ける。止めるのはユーザーに言われたときだけ

sakekasu-builder には PR 作成直後に watch を促す `PostToolUse` フック
（`scripts/pr-watch-reminder.mjs`）があるが、こちらにはまだ持ってきていない。
長いセッションでこの節が押し流されたら、それはそれとして watch を思い出すこと。

## 変更を入れる前に通すもの

```sh
npm run lint       # eslint
npm run typecheck  # tsc -b
npm test           # コアのロジックと画面
cd infra && npm test  # CDK のアサーションと Lambda の単体テスト
```

`packages/core` を触ったら、画面と Lambda の両方に影響が出る。どちらからも同じコードを
読んでいるので、テストは core に厚く置いてある。内訳の合計が明細の金額に一致するという
不変条件はプロパティテストで守っているので、分割まわりを変えるときはそこを消さないこと。

画面を変えたら、ローカルモード（`npm run dev`）で通しで動かして確かめる。AWS は要らない。

## AWS 確認作業の認証フロー

デプロイ先は sakekasu-builder と同じアカウント（232791540685 / ap-northeast-1）で、
リソース名の接頭辞 `sakekasu-kakeibo-{env}-` で分けている。

クラウドセッションから AWS を読むための読み取り専用プロファイル（`verify`、Permission Set
`AgentVerifyAccess`）の用意は、sakekasu-builder の `scripts/aws-sso-login.sh` と
`scripts/setup-aws-profile.sh` が担っている。このリポジトリには写していない。
同じ内容のシェルスクリプトを 2 つのリポジトリで抱えると、片方だけ直して気づけなくなるため。
このリポジトリのセッションで AWS を見る必要が出たら、そのときに 2 つを持ってくる。

プロファイルが用意できたら、AWS CLI の操作には必ず `--profile verify` を付ける。
このプロファイルは読み取り専用で、create / update / delete / put 系の変更操作はできない。
CloudWatch Logs とメトリクスは読めるが、S3 オブジェクト本文・DynamoDB レコード・
Cognito ユーザー・SSM パラメータは IAM 側で拒否される。

認証エラーに見える失敗が出たら、まずクラウド環境のネットワーク設定で `awsapps.com` と
`*.amazonaws.com` への到達が許可されているかを疑う。

## デプロイ

**デプロイは main へのマージ経由。手元からの `cdk deploy` は原則打たない。**
例外は 2 つだけで、`npx cdk bootstrap` と、Actions 用のロールを作る
`npx cdk deploy sakekasu-kakeibo-github-oidc -c github-oidc=true`。
どちらも Actions にロールを触らせないため、手で打つ。

確かめたいだけなら `cdk diff` までにとどめる。手順は
[docs/operations.md](docs/operations.md) にある。

Lambda と Bedrock のモデル ID を差し替えるときは、IAM に推論プロファイルと振り先の
foundation-model の両方の ARN が入っていることを確かめる。片方だけだと、振り先に当たった
リクエストだけが落ちる。理由は [infra/lib/api-stack.ts](infra/lib/api-stack.ts) のコメントにある。

## カテゴリ判定（Jev）

レシートの品目名と明細の店舗名のカテゴリは、Bedrock ではなく TypeSafe の Jev に聞いている。
OCR（生成）と判定（選択）で向いているモデルが違うため。大カテゴリを決めてから小カテゴリを
決める 2 段で、返ってくる確信度で「そのまま入れる / 人に見せる / 未分類に落とす」を分ける。
設計は [docs/design.md](docs/design.md) の「カテゴリ判定（2 段）」にある。

- 判定は無くても動くようにしておく。ローカルモードでも、鍵が無くても、TypeSafe が落ちても、
  キーワード表（`classifyItem`）とルールの答えで進む。判定を必須の経路にしない
- 材料づくりと採否は `packages/core/src/classify.ts` に置く。モデルの呼び出しは
  `infra/lambda/classify/` だけ。画面から同じ規則で読めるようにしておくため
- 外に出すのは品目名・店舗名・カテゴリ名だけ。画像、金額、日付、`sub` は送らない
- API キーは Secrets Manager に人が入れる（[docs/operations.md](docs/operations.md)）。
  SDK の `logLevel` を `debug` にしないこと。リクエストの本文とヘッダが CloudWatch に出る
