# 動かし方とデプロイ

## 手元で試す

AWS は要らない。データはブラウザの localStorage に入る。

```sh
npm install
npm run dev
```

カテゴリの試行錯誤はこのモードで始められる。CSV の取り込み、自動分類、内訳の分割、
上限の設定、月次レポートまで通しで動く。OCR と画像の保存だけは AWS が必要。

確認に使うコマンド。

```sh
npm run lint       # eslint
npm run typecheck  # tsc -b
npm test           # vitest（コアのロジックと画面）
cd infra && npm test  # CDK のアサーションと Lambda の単体テスト
```

## AWS へ初めて入れる

デプロイ先は sakekasu-builder と同じアカウント（232791540685 / ap-northeast-1）。
リソース名の接頭辞 `sakekasu-kakeibo-{env}-` で分けてある。

### 1. 証明書とドメイン

`kakeibo.sakekasu-builder.com` で配信する。`sakekasu-builder.com` のゾーンは Route53 にあり、
`infra/cdk.json` の context にゾーン ID を書いてあるので、追加の指定は要らない。

```
domainName:   kakeibo.sakekasu-builder.com
hostedZoneId: Z04931052NZ9UUTMOMG57
```

証明書は us-east-1 に `-cert` スタックが立てて発行し、検証用のレコードは CDK が Route53 へ入れる。
配信先を指す A / AAAA のエイリアスレコードも同じく自動で入る。手作業は無い。

ゾーンの所在は権威 DNS を引けば分かる。AWS の認証は要らない。

```sh
dig NS sakekasu-builder.com +short
# ns-1240.awsdns-27.org. のように awsdns が返れば Route53
```

ゾーン ID を取り直すときは、手元なら自分のプロファイルを使う。読み取り専用の `verify` プロファイルは
クラウドセッションでしか作られないので、手元で `--profile verify` を渡すと
「The config profile (verify) could not be found」で止まる。

```sh
aws configure list-profiles   # プロファイル名が分からなければ先にこれ
aws route53 list-hosted-zones \
  --query "HostedZones[?Name=='sakekasu-builder.com.'].[Id,Name]" \
  --output table --profile sakekasu-builder
```

ゾーンがデプロイ先と別のアカウントにある場合、CDK は検証レコードを入れられない
（`HostedZone.fromHostedZoneAttributes` は所在を確かめないので、synth は通ってデプロイで止まる）。
いまは両方とも 232791540685 にある。

#### ゾーンが Route53 から移ったとき

証明書を先に us-east-1 で手で発行し、検証用の CNAME を移り先の DNS に入れる。発行できたら
ARN を context で渡し、CloudFront を指すレコードも手で入れる。

```sh
aws acm request-certificate --domain-name kakeibo.sakekasu-builder.com \
  --validation-method DNS --region us-east-1
cd infra
npx cdk deploy --all -c env=dev -c hostedZoneId= \
  -c certificateArn=arn:aws:acm:us-east-1:232791540685:certificate/xxxx
```

ドメインを一旦外して CloudFront の既定ドメインで配信することもできる。後からドメインを足せる。

```sh
npx cdk deploy --all -c env=dev -c domainName=
```

DNS 検証つきの証明書を、ゾーンも ARN も渡さずに CDK に作らせてはいけない。検証レコードが入るまで
`cdk deploy` が待ち続けて、止まったように見える。context の 2 つはそれを避けるためにある。

### 2. スタックを入れる

```sh
cd infra
npm ci
npx cdk bootstrap  # このアカウントで初めて CDK を使う場合だけ
npx cdk deploy --all -c env=dev
```

スタックは 5 つ。`-auth` `-data` `-api` `-site` が ap-northeast-1 で、証明書の `-cert` だけが
CloudFront の制約で us-east-1 に立つ。証明書の ARN はリージョンを跨ぐため、CDK が
`Custom::CrossRegionExport{Writer,Reader}` を 1 つずつ置く（この 2 つはカスタムリソースを
作らない方針の唯一の例外。理由は design.md にある）。

### 3. 自分のユーザーを 1 つ作る

セルフサインアップは閉じてある。

```sh
aws cognito-idp admin-create-user \
  --user-pool-id <UserPoolId> \
  --username <メールアドレス> \
  --user-attributes Name=email,Value=<メールアドレス> Name=email_verified,Value=true \
  --region ap-northeast-1
```

仮パスワードがメールで届く。最初のサインインで新しいパスワードを求められるので、画面の
指示どおりに設定する。認証アプリの MFA は Cognito 側で任意にしてある。

### 4. フロントを置く

```sh
prefix=sakekasu-kakeibo-dev
export VITE_API_URL=$(aws cloudformation describe-stacks --stack-name $prefix-api \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text)
export VITE_USER_POOL_ID=$(aws cloudformation describe-stacks --stack-name $prefix-auth \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" --output text)
export VITE_USER_POOL_CLIENT_ID=$(aws cloudformation describe-stacks --stack-name $prefix-auth \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolClientId'].OutputValue" --output text)

npx vite build
bucket=$(aws cloudformation describe-stacks --stack-name $prefix-site \
  --query "Stacks[0].Outputs[?OutputKey=='SiteBucketName'].OutputValue" --output text)
aws s3 sync dist/ "s3://$bucket/" --delete --exclude index.html \
  --cache-control "public,max-age=31536000,immutable"
aws s3 cp dist/index.html "s3://$bucket/index.html" --cache-control "no-cache"
```

CloudFront の無効化は `index.html` だけでよい。ほかの資産はファイル名にハッシュが付く。

## GitHub Actions からデプロイする

`.github/workflows/deploy.yml` を手で起動する形にしてある。テストは `.github/workflows/test.yml` が PR とマージのたびに走る。使う前に 1 つ用意が要る。

GitHub OIDC で引き受けられるロールを作り、その ARN をリポジトリ変数 `AWS_DEPLOY_ROLE_ARN` に入れる。
sakekasu-builder には同じ仕組みのスタック（`infra/lib/github-oidc-stack.ts`）があるが、
あちらのロールは `repository: 'yuuuuuuu168/sakekasu-builder'` に絞った信頼ポリシーなので、
このリポジトリからは引き受けられない。sakekasu-kakeibo 用の信頼条件を足すか、別にロールを作る。

ロールに要る権限は、4 スタックのリソース（Cognito、DynamoDB、S3、Lambda、API Gateway、
CloudFront、EventBridge、IAM ロール、Logs）の作成と更新、CDK のブートストラップ用バケットへの
書き込み、それに配信用バケットへの `s3:PutObject` と CloudFront の
`cloudfront:CreateInvalidation`。

## 月次レポートを手で作り直す

毎月 1 日の 09:00（JST）に EventBridge が Lambda を叩く。過去の月を作り直したいときは直接呼ぶ。

```sh
aws lambda invoke --function-name sakekasu-kakeibo-dev-monthly-report \
  --payload '{"month":"2026-08"}' --cli-binary-format raw-in-base64-out /dev/stdout
```

## 費用の見込み

| 内訳 | 見込み |
| --- | --- |
| DynamoDB（オンデマンド） | 月 0.01 ドル未満。明細は年に千件ほど |
| S3 | 月 0.01 ドル未満。レシート画像は 90 日で消える |
| Lambda | 無料枠の中 |
| API Gateway（HTTP API） | 月 0.01 ドル未満 |
| CloudFront | 無料枠の中 |
| Bedrock（Claude Haiku） | レシート 1 枚で 0.2 円ほど。月 100 枚で 20 円 |
| Route53（ゾーンを新設した場合のみ） | 月 0.5 ドル |

既存のゾーンを使うなら、合計で月 0.1 ドルに届かない見込み。Bedrock の OCR がほぼ全部で、
そこも同時実行を 3 に絞ってあるので暴走しても天井がある。

## 消すとき

DynamoDB のテーブル、レシート用バケット、配信用バケット、Cognito のユーザープールは
`RemovalPolicy.RETAIN` にしてある。`cdk destroy` しても家計簿のデータは残る。
本当に消すなら、スタックを消した後にコンソールか CLI で個別に消す。
