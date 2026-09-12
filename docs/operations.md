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

デプロイ先は sakekasu-builder と同じアカウント（<アプリのアカウント ID> / ap-northeast-1）。
リソース名の接頭辞 `sakekasu-kakeibo-{env}-` で分けてある。

### 1. ドメインと証明書（いまは付けていない）

`kakeibo.sakekasu-builder.com` で配信する予定だが、**DNS の整理が済むまでは付けていない。**
`infra/cdk.json` から `domainName` と `hostedZoneId` を外してあり、CloudFront の既定ドメイン
（`https://xxxxxxxx.cloudfront.net`）で配信する。

#### なぜ付けられないか

`sakekasu-builder.com` の委任先ゾーンが、デプロイ先のアカウント（<アプリのアカウント ID>）に無い。

```
$ dig NS sakekasu-builder.com +short      # 実際に委任されている NS
ns-1240.awsdns-27.org. / ns-1718.awsdns-22.co.uk. / ns-804.awsdns-36.net. / ns-229.awsdns-28.com.

$ aws route53 get-hosted-zone --id Z04931052NZ9UUTMOMG57   # このアカウントのゾーンの NS
ns-1336.awsdns-39.org / ns-529.awsdns-02.net / ns-310.awsdns-38.com / ns-1620.awsdns-10.co.uk
```

噛み合っていない。このアカウントにあるゾーンは公開ゾーン（`PrivateZone: false`）だが、
レジストラからの委任を受けていない。ドメインもこのアカウントの Route53 Domains には
登録されていない。つまり本物のゾーンは別のアカウント（組織の管理アカウント <管理アカウント ID> が候補）にある。

このゾーン ID を context に入れて `cdk deploy` すると、証明書の検証レコードが誰も引かない
ゾーンに書かれ、ACM が永久に `PENDING_VALIDATION` のままになる。`cdk deploy` は待ち続け、
証明書が最初のスタックなので残りの 4 スタックも作られない（実際に 45 分待って気づいた）。

#### 付けるときの手順

本物のゾーンが別アカウントにあるなら、CloudFormation はそこにレコードを書けない。
サブドメインを委任するのが筋。

1. `kakeibo.sakekasu-builder.com` のゾーンをこのアカウントに作る
2. そのゾーンの 4 つの NS を、本物のゾーン側に `kakeibo` の NS レコードとして 1 つ入れる
   （別アカウントでの手作業はここだけ）
3. `infra/cdk.json` に書き戻す

   ```json
   "domainName": "kakeibo.sakekasu-builder.com",
   "hostedZoneId": "<新しく作ったゾーンの ID>"
   ```

以後この配下は全部このアカウントで完結し、証明書の発行・DNS 検証・エイリアスレコードは
CDK が面倒を見る。

委任が使えない場合は、証明書を手で発行して検証レコードを本物のゾーンに入れ、ARN を
`certificateArn` で渡す形になる。CloudFront を指すレコードも手で入れる。

```sh
aws acm request-certificate --domain-name kakeibo.sakekasu-builder.com \
  --validation-method DNS --region us-east-1
```

#### 使っていないゾーンについて

このアカウントの `Z04931052NZ9UUTMOMG57` は委任されておらず、何も解決していない。
証明書の検証で作られた `_xxxx.kakeibo...` の CNAME が残っているかもしれない。
本物のゾーンの所在が分かったら、混乱の元なので消すかどうかを決める。

### 2. 依存を入れる

**ルートと `infra` の両方で入れる。** Lambda のバンドルはリポジトリのルートで走り、
そこの `node_modules` から `esbuild` と `@kakeibo/core` を引くため、ルート側を飛ばすと
バンドルの段階で落ちる（症状は下の「よくある詰まり」にある）。

```sh
npm ci            # リポジトリのルートで
cd infra && npm ci
```

### 3. スタックを入れる

初回はロールを作るところだけ手で打ち、あとは Actions に任せる（下の
「GitHub Actions からデプロイする」に詳細がある）。

```sh
cd infra
npx cdk bootstrap  # このアカウントで初めて CDK を使う場合だけ
npx cdk deploy sakekasu-kakeibo-github-oidc -c github-oidc=true
```

このコマンドは Lambda をバンドルしない（`-c github-oidc=true` のときはアプリ本体の
スタックを合成しないため）。ルートの `npm ci` を忘れていても、ここだけは通る。

ロールができたら main へマージするか、Actions の画面から deploy を手で起動する。
手元から全部入れることもできる。こちらはバンドルが走るので、ルートの `npm ci` が要る。

```sh
npx cdk deploy --all -c env=dev
```

スタックは 5 つ。`-auth` `-data` `-api` `-site` が ap-northeast-1 で、証明書の `-cert` だけが
CloudFront の制約で us-east-1 に立つ。証明書の ARN はリージョンを跨ぐため、CDK が
`Custom::CrossRegionExport{Writer,Reader}` を 1 つずつ置く（この 2 つはカスタムリソースを
作らない方針の唯一の例外。理由は design.md にある）。

### 4. 自分のユーザーを 1 つ作る

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

### 5. API の CORS に配信元を入れる

独自ドメインを使っていない間は、CloudFront の既定ドメインを context の `siteOrigin` で渡す。
これを入れないと、配信したフロントから API を叩いたときに CORS で弾かれる。

配信スタックを作る前にはディストリビューションのドメインが決まらないので、初回だけ
2 回に分かれる。まず全部を作り、出てきたドメインを渡してもう一度打つ。

```sh
site=$(aws cloudformation describe-stacks --stack-name sakekasu-kakeibo-dev-site \
  --query "Stacks[0].Outputs[?OutputKey=='SiteUrl'].OutputValue" --output text)
echo "$site"

cd infra
npx cdk deploy sakekasu-kakeibo-dev-api -c env=dev -c siteOrigin="$site"
```

`infra/cdk.json` の context に `"siteOrigin": "https://xxxxxxxx.cloudfront.net"` と書いておけば、
以後の Actions からのデプロイでも維持される。独自ドメインを付けたら要らなくなる。

### 6. フロントを置く

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

デプロイは main へのマージ経由にする。手元からの `cdk deploy` は、下に挙げる 2 つの例外を除いて
打たない。誰がいつ何を出したかが Actions のログに揃うほうが、後から追える。

`.github/workflows/deploy.yml` が main への push で走る。対象は `infra/**` `src/**` `packages/**`
と設定ファイル。手で起動することもできる（Actions の画面から環境を選ぶ）。

### ジョブを 2 つに分けている理由

`infra` ジョブが `cdk deploy --all` を打ち、スタックの出力（API の URL、UserPool の ID、
配信先のバケットとディストリビューション）をジョブの出力に載せる。`site` ジョブがそれを受けて
フロントをビルドし、S3 へ同期して `index.html` を無効化する。

分けているのは、フロントのビルドに AWS の認証情報を持ち込まないため。`npm ci` と
`npm test` も認証情報を入れる前に済ませている。npm のライフサイクルスクリプトと Vite の
プラグインはどちらも依存のコードで、認証後に走らせると、依存が 1 つ乗っ取られただけで
`AWS_SESSION_TOKEN` を読んで `cdk-hnb659fds-*` ロールへ入れてしまう。`--ignore-scripts` も
付けて二重に塞いでいる。この考え方は sakekasu-builder の `deploy.yml` から持ってきた。

### 一度だけ手で入れるもの

デプロイに使うロールは `sakekasu-kakeibo-github-oidc` スタックが作る。Actions 自身に
自分のロールを触らせると、更新ミスで自分を締め出す恐れがあるので、`--all` から外して
フラグ付きの手動デプロイ専用にしてある。

```sh
npm ci && cd infra && npm ci
npx cdk bootstrap  # このアカウントで CDK 初回のときだけ
npx cdk deploy sakekasu-kakeibo-github-oidc -c github-oidc=true
```

このフラグを立てると、アプリ本体のスタックは合成されない。`cdk deploy --all -c github-oidc=true`
でロールまで巻き込めてしまうのを避けるため、フラグの有無でどちらか一方だけを作るようにしている。

ロールの作りは 3 点。

- 引き受けられるのは `repo:yuuuuuuu168/sakekasu-kakeibo:ref:refs/heads/main` のときだけ。
  PR からも、ほかのブランチからも、ほかのリポジトリからも入れない
- 作成・変更の権限そのものは持たせず、CDK bootstrap が作った `cdk-hnb659fds-*` ロールへの
  `sts:AssumeRole` だけを許す。実際の権限は bootstrap 側に委ねる
- これに加えて、配信のための最小限（スタック出力の読み取り、配信用バケットへの同期、
  `cloudfront:CreateInvalidation`）だけを直接持つ

OIDC プロバイダー自体は作らない。1 つの AWS アカウントに同じ URL のプロバイダーは 1 つしか
置けず、`token.actions.githubusercontent.com` のものは sakekasu-builder の
`sakekasu-github-oidc` スタックが既に持っている。作ろうとすると `EntityAlreadyExists` で落ちる。

信頼ポリシー（`github-oidc-stack.ts`）を変えたときは、同じコマンドを打ち直してロールを
作り直す。Actions の `--all` には入っていないので、マージしただけでは反映されない。

### 手元から打ってよい例外

1. 上の `sakekasu-kakeibo-github-oidc`（Actions に自分のロールを触らせないため）
2. `npx cdk bootstrap`（ロールを作る前に必要）

それ以外は main へマージする。急ぎで確かめたいときは `cdk diff` までにとどめる。

```sh
cd infra
npx cdk diff -c env=dev --profile sakekasu-builder
```

## よくある詰まり

### `npx canceled due to missing packages` で `Failed to bundle asset`

```
npm error npx canceled due to missing packages and no YES option: ["esbuild@0.28.2"]
[«FailedToBundleAsset» Failed to bundle asset sakekasu-kakeibo-dev-api/ApiFunction/Code/Stage
 ... npx --no-install esbuild --bundle ... run in directory <リポジトリのルート>
```

ルートの `npm ci` を打っていない。Lambda のバンドルは `infra` ではなくリポジトリの
ルートで走る（`NodejsFunction` の `depsLockFilePath` にルートの `package-lock.json` を
渡しているため）。`esbuild` はルートの devDependencies にあり、`@kakeibo/core` も
ルートの `node_modules` のワークスペースリンク経由で解決される。

```sh
npm ci   # リポジトリのルートで
```

### `-c github-oidc=true` を付けたのにアプリ本体のスタックが合成される

そのフラグを見る分岐が手元のコードに入っていない。`infra/bin/app.ts` に
`github-oidc` の文字列があるかを見る。

```sh
grep -c github-oidc infra/bin/app.ts   # 0 なら古い
git pull origin main
```

### `cdk deploy` が証明書のスタックで終わらない

`sakekasu-kakeibo-dev-cert` が `CREATE_IN_PROGRESS` のまま何十分も動かない場合。
ACM の検証レコードを、委任されていないゾーンに書いている。

```sh
# 期待するレコードと検証の状態
arn=$(aws acm list-certificates --region us-east-1 \
  --query "CertificateSummaryList[?DomainName=='kakeibo.sakekasu-builder.com'].CertificateArn" --output text)
aws acm describe-certificate --region us-east-1 --certificate-arn "$arn" \
  --query "Certificate.DomainValidationOptions"

# そのゾーンが本当に委任先かどうか（NS が dig の結果と一致するか）
aws route53 get-hosted-zone --id <ゾーン ID> \
  --query "{Private:HostedZone.Config.PrivateZone,NS:DelegationSet.NameServers}"
dig NS sakekasu-builder.com +short
```

レコードが Route53 に存在していても、そのゾーンが委任先でなければ公開 DNS からは引けない。
`dig +short CNAME <検証レコード名>` が空なら、それが起きている。

止めるにはスタックを消す。CloudFormation は待ち続けるので、Actions の実行を止めただけでは終わらない。

```sh
aws cloudformation delete-stack --region us-east-1 --stack-name sakekasu-kakeibo-dev-cert
```

### `Not authorized to perform sts:AssumeRoleWithWebIdentity`

Actions の `configure-aws-credentials` が 12 回リトライして落ちる場合。ロールの信頼ポリシーが
トークンの `sub` と噛み合っていない。**AWS はロールが存在しないときにも同じエラーを返す**ので、
名前や ARN の綴りも一緒に疑うことになる。

GitHub が発行する `sub` には 2 つの形式がある。実測（2026-09-12、main への push）はこちら。

```
repo:yuuuuuuu168@173623628/sakekasu-kakeibo@1367094471:ref:refs/heads/main
```

オーナー名とリポジトリ名のうしろに数値 ID が付く。名前を変えても同一性が保たれるようにする
新しい形式で、`173623628` がオーナー ID、`1367094471` がリポジトリ ID。旧形式は ID が付かない。

```
repo:yuuuuuuu168/sakekasu-kakeibo:ref:refs/heads/main
```

`infra/lib/github-oidc-stack.ts` は `StringLike` で両方を許している。ID の部分はワイルドカードで、
`@` の前のオーナー名とリポジトリ名は厳密に一致する必要がある（どちらも `@` を含められない）。

実際の `sub` を確かめたいときは、トークンの claims を出すステップを一時的に足す。
トークン本体は出さないこと。

```yaml
      - name: OIDC の claims を確認（一時）
        run: |
          set -euo pipefail
          response=$(curl -sS -H "Authorization: bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}" \
            "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=sts.amazonaws.com")
          payload=$(printf '%s' "$response" | jq -r '.value' | cut -d. -f2 | tr '_-' '/+')
          case $(( ${#payload} % 4 )) in
            2) payload="${payload}==" ;;
            3) payload="${payload}=" ;;
          esac
          printf '%s' "$payload" | base64 -d | jq '{iss, aud, sub, ref, event_name}'
```

信頼ポリシーを直したら、ロールを作り直す必要がある。このスタックは Actions のデプロイ対象に
入っていないので、手元から打つ。

```sh
cd infra
npx cdk deploy sakekasu-kakeibo-github-oidc -c github-oidc=true
```

### `The config profile (verify) could not be found`

`verify` はクラウドセッション専用のプロファイル。手元では自分のプロファイルを使う。
`scripts/aws-sso-login.sh` が「Local session detected」で止まるのも同じ理由。

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
