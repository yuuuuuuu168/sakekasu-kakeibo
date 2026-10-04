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

### 1. ドメインと証明書（いまは付けていない）

`kakeibo.sakekasu-builder.com` で配信する予定だが、**DNS の整理が済むまでは付けていない。**
`infra/cdk.json` から `domainName` と `hostedZoneId` を外してあり、CloudFront の既定ドメイン
（`https://xxxxxxxx.cloudfront.net`）で配信する。

#### なぜ付けられないか

`sakekasu-builder.com` の委任先ゾーンが、デプロイ先のアカウント（232791540685）に無い。

```
$ dig NS sakekasu-builder.com +short      # 実際に委任されている NS
ns-1240.awsdns-27.org. / ns-1718.awsdns-22.co.uk. / ns-804.awsdns-36.net. / ns-229.awsdns-28.com.

$ aws route53 get-hosted-zone --id Z04931052NZ9UUTMOMG57   # このアカウントのゾーンの NS
ns-1336.awsdns-39.org / ns-529.awsdns-02.net / ns-310.awsdns-38.com / ns-1620.awsdns-10.co.uk
```

噛み合っていない。このアカウントにあるゾーンは公開ゾーン（`PrivateZone: false`）だが、
レジストラからの委任を受けていない。ドメインもこのアカウントの Route53 Domains には
登録されていない。つまり本物のゾーンは別のアカウント（組織の管理アカウントが候補）にある。

このゾーン ID を context に入れて `cdk deploy` すると、証明書の検証レコードが誰も引かない
ゾーンに書かれ、ACM が永久に `PENDING_VALIDATION` のままになる。`cdk deploy` は待ち続け、
証明書が最初のスタックなので残りの 4 スタックも作られない（実際に 45 分待って気づいた）。

#### 付けるときの手順

本物のゾーンが別アカウントにあるなら、CloudFormation はそこにレコードを書けない。
サブドメインを委任するのが筋。

**1. サブドメインのゾーンをこのアカウントに作る**

`cdk.json` の context に `dnsZone` が入っていれば、`sakekasu-kakeibo-{env}-dns` が
合成される。main へのマージで立つ。ゾーンを作るだけなので待ち時間は無い。

```json
"dnsZone": "kakeibo.sakekasu-builder.com"
```

立ったらゾーン ID と NS 4 つを読む。

```sh
aws cloudformation describe-stacks --stack-name sakekasu-kakeibo-dev-dns \
  --query "Stacks[0].Outputs[*].[OutputKey,OutputValue]" --output table
```

**2. 親のゾーン側に NS レコードを 1 つ入れる**

ここだけ別アカウント（本物のゾーンがある方）での手作業になる。入れるのは
`kakeibo.sakekasu-builder.com` の NS レコード 1 本で、値は 1 で読んだ 4 つ。

```sh
# 親のゾーンがあるアカウントで打つ
cat > /tmp/delegate.json <<'JSON'
{
  "Comment": "sakekasu-kakeibo へサブドメインを委任する",
  "Changes": [{
    "Action": "UPSERT",
    "ResourceRecordSet": {
      "Name": "kakeibo.sakekasu-builder.com",
      "Type": "NS",
      "TTL": 300,
      "ResourceRecords": [
        {"Value": "ns-xxxx.awsdns-xx.org"},
        {"Value": "ns-xxxx.awsdns-xx.co.uk"},
        {"Value": "ns-xxxx.awsdns-xx.net"},
        {"Value": "ns-xxxx.awsdns-xx.com"}
      ]
    }
  }]
}
JSON
aws route53 change-resource-record-sets \
  --hosted-zone-id <親のゾーンの ID> --change-batch file:///tmp/delegate.json
```

親のゾーンの ID は、そのアカウントで `aws route53 list-hosted-zones` を打ち、
`dig NS sakekasu-builder.com +short` が返す NS と `get-hosted-zone` の NS が
一致するゾーンを選ぶ。名前だけで選ぶと、今回のように委任されていないゾーンを
掴んでしまう。

**3. 委任が効いたことを確かめる**

```sh
dig NS kakeibo.sakekasu-builder.com +short
```

1 で読んだ 4 つが返ってくれば通っている。TTL の都合で数分かかることがある。
**ここを飛ばして 4 に進むと、45 分待つやつが再現する。**

**4. `infra/cdk.json` に書き戻す**

```json
"domainName": "kakeibo.sakekasu-builder.com",
"hostedZoneId": "<1 で読んだゾーン ID>",
"zoneName": "kakeibo.sakekasu-builder.com"
```

`zoneName` を明示するのが要点。省くと `domainName` の先頭を落とした
`sakekasu-builder.com` が既定値になり、こちらのアカウントに無いゾーンを指してしまう
（サブドメイン委任では、ゾーン名はサブドメインそのもの）。

以後この配下は全部このアカウントで完結し、証明書の発行・DNS 検証・エイリアスレコードは
CDK が面倒を見る。

`siteOrigin` はしばらく残しておく。CloudFront の既定ドメインでも引き続き配信されるので、
消すと古い URL を開いたときだけ CORS で弾かれる。ブックマークを入れ替えてから消す。

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
アプリ本体のスタックは cdkd で入る（下の「cdkd で出している理由と仕組み」を参照）。

スタックは 3 つ。`-data` `-api` `-site` がすべて ap-northeast-1 に立つ。
ログインのユーザープールは共通基盤の持ち物なので、このリポジトリにはスタックが無い
（以前あった旧ユーザープールの `-auth` は外した。下の「共通ログインへの切り替え（済み）」）。

`cdk.json` に `domainName` を書き戻すと 4 つになり、証明書の `-cert` だけが CloudFront の
制約で us-east-1 に立つ。証明書の ARN はリージョンを跨ぐため、CDK が
`Custom::CrossRegionExport{Writer,Reader}` を 1 つずつ置く（この 2 つはカスタムリソースを
作らない方針の唯一の例外。理由は design.md にある）。

いまの dev は、発行済みの証明書の ARN を `cdk.json` の context `certificateArn` で渡している。
こうすると `-cert` スタックは合成されず、`-site` にも `Custom::CrossRegionExportReader` が
置かれない。cdkd（0.294.7）は Reader の属性を物理 ID に解決してしまい、ディストリビューションの
更新が通らないため（2026-10-04）。`-cert` の証明書と Writer は us-east-1 にそのまま残り、
cdkd の状態も残るが、以後のデプロイでは触らない。証明書は ACM が DNS 検証で自動更新する。

### 4. ログインのユーザー（共通ログイン）

ログインは 4 アプリ（reinvent、builder、kakeibo、learning）共通のユーザープールで行う。
共通基盤のリポジトリ sakekasu-integrated_environment がデプロイしていて、
このリポジトリではユーザーもプールも作らない。使う値は `infra/cdk.json` の context `sharedAuth` にある。

| 項目 | 値 |
| --- | --- |
| ユーザープール ID | `sharedAuth.userPoolId`（`ap-northeast-1_yw1VDKtxW`） |
| マネージドログインのドメイン | `sharedAuth.domain`（`https://auth.sakekasu-builder.com`） |
| kakeibo のアプリクライアント ID | `sharedAuth.clientId`（認可コード + PKCE のみ。シークレットなし） |
| 戻り先として登録済みの URL | `https://kakeibo.sakekasu-builder.com/` と `http://localhost:5173/`（末尾の `/` まで一致させる） |

ユーザーの作り方は共通基盤の `docs/identity.md` の「ユーザーを作る」にある。
セルフサインアップは無く、パスワードは 16 文字以上、MFA（認証アプリの TOTP）は必須。

画面の「ログイン画面へ」を押すとマネージドログインへ移り、そこでパスワードと 6 桁を入れる。
初回はパスワードの変更と認証アプリの登録もマネージドログインの画面が行う。この画面には
ユーザー名やパスワードの入力欄は無い。ほかのアプリで先にログインしていれば、入力なしで戻ってくる。

共通ログインのスコープは `openid` `email` `profile` だけで、`aws.cognito.signin.user.admin` は無い。
Amplify の `fetchUserAttributes`、`setUpTOTP`、`updateMFAPreference`、`updatePassword` など、
そのスコープが要る API は画面から呼べない。ユーザーの情報が要るときは `fetchAuthSession` の
トークンのクレームから読む（いまはユーザー名もメールも画面に出していない）。

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

dev については済んでいる。2026-09-12 の初回デプロイで出たディストリビューションの
ドメイン（`https://d6f8ub6380j2a.cloudfront.net`）が `cdk.json` に入っているので、
作り直さない限りこの手順を踏む必要はない。配信スタックを消して作り直したときは
ドメインが変わるため、書き換える。

### 6. カテゴリ判定の API キーを入れる

CDK が作るのは空の入れ物（Secrets Manager）だけで、鍵は人が入れる。
入れるまでカテゴリ判定は 502 で返り、画面はキーワード表とルールの答えで進む。
レシートも明細も、鍵が無くても使える。

```sh
# TypeSafe のコンソール（https://typesafe.ai）で発行した鍵を、そのまま値として入れる
aws secretsmanager put-secret-value \
  --secret-id sakekasu-kakeibo-dev-typesafe-api-key \
  --secret-string 'ts-...'
```

JSON ではなく鍵の文字列そのままを入れること。`{"apiKey": "..."}` の形は読まない。
差し替えたときは、暖まっている Lambda が古い鍵を掴んだままになることがある
（鍵はコンテナごとに 1 回だけ読む）。すぐ効かせたいときは関数の環境変数を
何か触って入れ替える。

読み取り専用の `verify` プロファイルではシークレットの値を読めない。
入っているかどうかは、判定を 1 回通してみるか CloudWatch Logs の
`sakekasu-kakeibo-dev-classify` を見るほうで確かめる。

### 7. フロントを置く

ふだんは deploy ワークフローが行う。手で置くときは次のとおり。ログインの値（共通ログイン）は
API スタックの出力にある。

```sh
cd infra
prefix=sakekasu-kakeibo-dev
out() { npx cdkd state show "$1" --stack-region ap-northeast-1 --json | jq -r --arg k "$2" '.state.outputs[$k]'; }
export VITE_API_URL=$(out $prefix-api ApiUrl)
export VITE_USER_POOL_ID=$(out $prefix-api AuthUserPoolId)
export VITE_USER_POOL_CLIENT_ID=$(out $prefix-api AuthClientId)
export VITE_AUTH_DOMAIN=$(out $prefix-api AuthDomain)
bucket=$(out $prefix-site SiteBucketName)
cd ..

npx vite build
aws s3 sync dist/ "s3://$bucket/" --delete --exclude index.html \
  --cache-control "public,max-age=31536000,immutable"
aws s3 cp dist/index.html "s3://$bucket/index.html" --cache-control "no-cache"
```

4 つの `VITE_*` のどれかが欠けると、画面はローカルモード（localStorage）で動く。
`VITE_AUTH_DOMAIN` は `https://` を付けないホスト名（`auth.sakekasu-builder.com`）。

手元の `npm run dev`（`http://localhost:5173/`）でも同じ 4 つを入れれば共通ログインで入れる。
戻り先に localhost を登録してあるため。

CloudFront の無効化は `index.html` だけでよい。ほかの資産はファイル名にハッシュが付く。

## 共通ログインへの切り替え（済み）

ログインをこのアプリ専用のユーザープール（旧プール `ap-northeast-1_O1PQB99IK`、`-auth` スタック）から、
4 アプリ共通のユーザープール（`ap-northeast-1_yw1VDKtxW`）へ移した。2026-10 に済んでいる。

- API の JWT の検証と画面のログインは共通ログインに向いている
- データは Cognito の `sub` で分けていて（DynamoDB の `pk` が `USER#<sub>`、レシート画像が
  `receipts/<sub>/...`）、`sub` はプールごとに違う。旧 sub の下の項目は新 sub の下へ写した
  （レシート画像は 0 件だった）
- 旧プールを作っていた `-auth` スタックは、`bin/app.ts` から外した。残りの後片付け
  （cdkd の状態、旧プールそのもの、旧 sub の項目）は下の「後片付け」で手で行う

写すのに使ったスクリプト（`infra/scripts/copy-user-data/`）は役目を終えたので消した。
もう一度プールを替えることがあれば、コミット `ad0ba54` から取り出せる（既定は dry-run、
`--apply` で条件付き書き込み、旧データは消さない）。

共通プールのユーザー名と sub は次で調べられる。

```sh
aws cognito-idp list-users --user-pool-id ap-northeast-1_yw1VDKtxW --region ap-northeast-1 \
  --filter 'email = "<メールアドレス>"' \
  --query 'Users[].{username:Username,email:Attributes[?Name==`email`]|[0].Value,sub:Attributes[?Name==`sub`]|[0].Value}' \
  --output table
```

切り戻し（旧プールへ戻す）は、旧プールを消した時点でできなくなる。

### 後片付け

`-auth` スタックを外す PR を main へマージし、**deploy ワークフローが成功したのを確かめてから**、
Mac で次を順に打つ。マージ前やデプロイが落ちた状態で打たないこと（コードにスタックが残っている間に
状態だけ消すと、次の `cdkd deploy --all` が旧プールを新しく作り直す）。

スタックをアプリから外しただけでは、cdkd は何も消さない。`cdkd deploy --all` は合成した
スタックだけを扱い、アプリに無いスタックの状態（S3 の `cdkd/sakekasu-kakeibo-dev-auth/ap-northeast-1/state.json`）
には触らない。そのため状態の削除とプールの削除は人が打つ。

旧プールには削除保護を掛けていない（CDK の既定のまま）し、ドメインも付けていないが、
消す前に念のため確かめる手順を入れてある。どれも書き込みの権限が要るので、読み取り専用の
`verify` プロファイルでは通らない。Claude のセッションからも打たない。

```sh
export AWS_PROFILE=sakekasu-builder   # 書き込みの権限があるプロファイル
export AWS_REGION=ap-northeast-1
old_pool=ap-northeast-1_O1PQB99IK
table=sakekasu-kakeibo-dev
```

1. 旧 sub を旧プールから調べる。プールを消すと引けなくなるので、最初に行う。
   ユーザーは 1 人だけのはずなので、表に 1 行だけ出ることを確かめてから変数に入れる

   ```sh
   aws cognito-idp list-users --user-pool-id "$old_pool" \
     --query 'Users[].{username:Username,email:Attributes[?Name==`email`]|[0].Value,sub:Attributes[?Name==`sub`]|[0].Value}' \
     --output table
   old_sub=$(aws cognito-idp list-users --user-pool-id "$old_pool" \
     --query 'Users[0].Attributes[?Name==`sub`]|[0].Value' --output text)
   echo "$old_sub"
   ```

2. 旧 sub の下の項目を一覧で確かめる。写した明細などが並ぶ。月次レポートの Lambda は
   テーブルにいる `pk` を全部回すので、1 日を跨ぐと `REPORT#<月>` が増えていることがある。
   新 sub（上の共通プールの `list-users` で出る sub）と取り違えていないことも確かめる

   ```sh
   aws dynamodb query --table-name "$table" \
     --key-condition-expression 'pk = :pk' \
     --expression-attribute-values "{\":pk\":{\"S\":\"USER#$old_sub\"}}" \
     --projection-expression 'pk, sk' --output table
   ```

3. 一覧に出た項目を全部消す。2 と同じ問い合わせの結果を 1 件ずつ消す

   ```sh
   aws dynamodb query --table-name "$table" \
     --key-condition-expression 'pk = :pk' \
     --expression-attribute-values "{\":pk\":{\"S\":\"USER#$old_sub\"}}" \
     --projection-expression 'pk, sk' --output json \
     | jq -c '.Items[]' \
     | while read -r key; do
         echo "消す: $key"
         aws dynamodb delete-item --table-name "$table" --key "$key"
       done
   ```

   2 をもう一度打って、空になったことを確かめる。レシート画像は写した時点で 0 件だったが、
   `aws s3 ls "s3://sakekasu-kakeibo-dev-receipts-$(aws sts get-caller-identity --query Account --output text)/receipts/$old_sub/"`
   で何も出ないことも見ておく（出たら `aws s3 rm --recursive` で同じ場所を消す）

4. cdkd の状態から `-auth` スタックを消す。アプリから外したスタックなので、`cdkd destroy`
   （合成したアプリを読む）ではなく、状態だけで動く `cdkd state destroy` を使う。
   確認を訊かれるので、対象が `sakekasu-kakeibo-dev-auth` だけであることを見て答える

   ```sh
   cd infra
   npx cdkd state resources sakekasu-kakeibo-dev-auth --stack-region ap-northeast-1
   npx cdkd state destroy sakekasu-kakeibo-dev-auth --stack-region ap-northeast-1
   npx cdkd state list   # sakekasu-kakeibo-dev-auth が消えていること
   cd ..
   ```

   このとき cdkd（0.291.16）は、状態に記録された `DeletionPolicy` に従う。

   - UserPoolClient（`DeletionPolicy` なし）は**消す**
   - UserPool（`RemovalPolicy.RETAIN` なので `DeletionPolicy: Retain`）は**消さずに残し**、
     「retained — DeletionPolicy: Retain」と出す
   - 全部が消えるか残されるかで終われば、スタックの状態ファイルを消す。1 つでも失敗すると状態は残る
     ので、原因を直して同じコマンドを打ち直す

   `--remove-protection` は付けなくてよい。Retain のプールは削除の対象にならないので効かない。
   状態だけを消してクライアントも残したいときは `cdkd state orphan` だが、どのみち次の手順で
   プールごと消すので、ここでは `state destroy` にしている

5. 旧プールそのものを消す。削除保護とドメインを先に確かめる

   ```sh
   aws cognito-idp describe-user-pool --user-pool-id "$old_pool" \
     --query 'UserPool.{Name:Name,DeletionProtection:DeletionProtection,Domain:Domain,CustomDomain:CustomDomain,EstimatedNumberOfUsers:EstimatedNumberOfUsers}' \
     --output table
   ```

   `Name` が `sakekasu-kakeibo-dev` であることを確かめる（共通プールの `ap-northeast-1_yw1VDKtxW` と
   取り違えない）。`Domain` か `CustomDomain` が出たら、先にドメインを外す

   ```sh
   aws cognito-idp delete-user-pool-domain --user-pool-id "$old_pool" --domain <出たドメイン>
   ```

   `DeletionProtection` が `ACTIVE` なら外す。`update-user-pool` は渡さなかった設定を既定に戻すが、
   消すプールなので構わない

   ```sh
   aws cognito-idp update-user-pool --user-pool-id "$old_pool" --deletion-protection INACTIVE
   ```

   そのうえで消す。プールに残っているアプリクライアントとユーザーも一緒に消える

   ```sh
   aws cognito-idp delete-user-pool --user-pool-id "$old_pool"
   aws cognito-idp describe-user-pool --user-pool-id "$old_pool"   # ResourceNotFoundException になること
   ```

## GitHub Actions からデプロイする

デプロイは main へのマージ経由にする。手元からの `cdk deploy` は、下に挙げる 2 つの例外を除いて
打たない。誰がいつ何を出したかが Actions のログに揃うほうが、後から追える。

`.github/workflows/deploy.yml` が main への push で走る。対象は `infra/**` `src/**` `packages/**`
と設定ファイル。手で起動することもできる（Actions の画面から環境を選ぶ）。

### cdkd で出している理由と仕組み

アプリ本体のスタック（`-dns` `-data` `-api` `-cert` `-site`）は
[cdkd](https://github.com/go-to-k/cdkd) で出している。CDK のコードはそのままで、
合成したテンプレートを CloudFormation に渡す代わりに、cdkd が依存関係を読んで AWS の API を
直接並列に叩く。CloudFormation の変更セットの作成と、変更の無いスタックの確認待ちが無くなる。

- **状態**：S3 の `cdkd-state-232791540685` に `cdkd/{スタック名}/{リージョン}/state.json` として
  置く。スタックの出力もここにある。CloudFormation のコンソールにはアプリ本体のスタックが出ない
- **Lambda のコード**：`cdkd-assets-232791540685-{リージョン}` に置く。証明書の `-cert` スタックの
  カスタムリソース用に us-east-1 にも作る
- **ロール**：cdkd は CDK bootstrap の `cdk-hnb659fds-*` ロールを使えない（CloudFormation に
  権限を委ねる前提の作りのため）。そこで `sakekasu-kakeibo-cdkd-deploy` スタックが
  `sakekasu-kakeibo-github-actions-cdkd` ロールを作り、Actions はこれを引き受けて cdkd を動かす。
  権限は AdministratorAccess。main の Actions は以前から CloudFormation 経由で
  `cdk-hnb659fds-cfn-exec-role`（bootstrap の既定で AdministratorAccess）を使えていたので、
  main から届く権限の上限は変わらない。引き受けられるのは deploy ロールと同じく main だけ
- **ガードレール**：上の管理者権限に、Deny だけの inline ポリシー `deploy-guardrail` を重ねている。
  同じアカウントにいる他のアプリ（App タグが kakeibo 以外のリソース、`sakekasu-kakeibo-` 以外の
  IAM ロール、他のアプリの cdkd の状態）と、IAM ユーザー・Organizations などには触れない。
  cdkd が誤った差分を出したときに、壊れるのを kakeibo の中に留めるためのもの。中身は
  `infra/lib/deploy-guardrail.ts`。新しいリソースの作成で AccessDenied が出たら、まずここを疑う
- **ロールのスタック**：これだけは CloudFormation で入れる。deploy ワークフローが毎回、
  deploy ロールで `cdk deploy sakekasu-kakeibo-cdkd-deploy -c cdkd-deploy=true` を打つ。
  cdkd に自分の権限の出どころを管理させると、壊したときに直す手段が無くなるため。
  ここを壊しても deploy ロールは無傷で残るので、次の push で直せる

`infra` ジョブの流れは次のとおり。

1. deploy ロールで cdkd 用ロールのスタックを入れる
2. cdkd ロールに切り替え、初回だけ `cdkd bootstrap` を打つ（ap-northeast-1 と us-east-1）
3. `infra/scripts/migrate-to-cdkd.sh` で、まだ CloudFormation にあるスタックを cdkd へ移す。
   移し終えていれば何もしない
4. `cdkd deploy --all`
5. スタックの出力を cdkd の状態から読み、`site` ジョブへ渡す

### CloudFormation から cdkd への移行

`infra/scripts/migrate-to-cdkd.sh` が deploy のたびに走り、CloudFormation のスタックが
残っていれば cdkd へ移す。人が打つものは無い。

- 先に全スタックを `cdkd import --dry-run` で調べ、全リソースを取り込めると分かったときだけ移す。
  1 つでも取り込めないものがあれば、どのスタックにも手を付けず、その回は `cdk deploy`
  （CloudFormation）で出す。ワークフローに警告が出る
- 移すときは `cdkd import --migrate-from-cloudformation` を使う。全リソースに
  `DeletionPolicy: Retain` を付けてから CloudFormation のスタックを消すので、AWS 上の
  リソースは消えない。消えるのはスタックの記録だけ
- 使う側から順に移す（site → api → cert → data → dns）。CloudFormation は、
  他のスタックが `Fn::ImportValue` で読んでいる export を持つスタックを消せないため
- 「CloudFormation のスタックが残っていて、cdkd の状態が無い」スタックは cdkd に渡さない。
  cdkd はそれを新規作成とみなし、テーブルやバケットは名前の衝突で落ち、Cognito の
  UserPool は 2 つ目を黙って作る

cdkd 0.291.16 の `cdkd import` には、この移行に当たる不具合が 2 つあり、スクリプトで避けている。
どちらも cdkd 側で直ったら回避を消す。

- CloudFormation を読むクライアントが、スタックのリージョンではなく実行時の `AWS_REGION` で
  作られる。us-east-1 の `-cert` スタックが見つからず、全リソースが「not found」になる。
  スタックごとに `AWS_REGION` を合わせて打つ
- Cognito の UserPoolClient の ID を CloudFormation の値（ClientId だけ）のまま渡すので、
  Cloud Control が求める `UserPoolId|ClientId` の形にならず取り込みに失敗する。
  CloudFormation から両方を引いて `--resource` で明示する

### ジョブを 2 つに分けている理由

`infra` ジョブが `cdkd deploy --all`（cdkd へ移せなかった回だけ `cdk deploy --all`）を打ち、スタックの出力（API の URL、共通ログインの値、
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

カテゴリ判定の API キーも、一度だけ手で入れるものに入る（上の「6. カテゴリ判定の API キーを
入れる」）。Actions には渡さない。渡すと、鍵がワークフローの秘密とシークレットの 2 か所に
散ることになる。

### 手元から打ってよい例外

1. 上の `sakekasu-kakeibo-github-oidc`（Actions に自分のロールを触らせないため）
2. `npx cdk bootstrap`（ロールを作る前に必要。cdkd 用ロールのスタックがまだ使う）

それ以外は main へマージする。急ぎで確かめたいときは `cdkd diff` までにとどめる。
アプリ本体に CloudFormation のスタックはもう無いので、`cdk diff` は全部を新規作成と表示する。

```sh
cd infra
npx cdkd diff -c env=dev --profile sakekasu-builder
```

`cdkd diff` は S3 の状態ファイルを読むので、読み取り専用の `verify` プロファイルでは
通らない（S3 のオブジェクト本文を読めない）。

## PR のセキュリティレビュー

PR の差分を AWS Security Agent に読ませ、指摘を PR のコメントに残す。設計レビューと
コードレビューは 2025 年 12 月のプレビューで入った機能で、ペネトレーションテストだけが
2026 年 3 月に GA になっている。ここで使うのはコードレビューのほうなので、いまはプレビュー。

**リポジトリに置くものは無い。** 設定は AWS のコンソールと GitHub App の側で完結する。
ワークフローを 1 本足す方式（`anthropics/claude-code-security-review` など）も試したが、
AWS で 1 本に寄せる判断をして入れていない。長命の API キーを Secrets に置かずに済むのも
こちらの利点になる。

### 先に確かめること

sakekasu-builder が既に AWS Security Agent に繋がっている。**その連携がどの AWS アカウントから
張られているかを先に見る。**

「1 つの GitHub アカウント（組織）は 1 つの AWS アカウントにしか紐づけられない」制約があるため。
GitHub App は 1 アカウントに 1 回しか入れられず、そのインストールが AWS アカウント 1 つに
結びつく。builder も kakeibo も同じ `yuuuuuuu168` の下にあるので、

- builder の連携が 232791540685 から張ってあるなら、そのまま kakeibo を足せる
- 別の AWS アカウントから張ってあるなら、そちらに寄せるしかない。kakeibo 用に
  別アカウントから繋ぐことはできない

デプロイ先が同じアカウントであることと、Security Agent の連携をどのアカウントから張ったかは
別の話なので、コンソールで実際に見る。

### 入れ方

1. **Agent Space を kakeibo 用に新しく作る。** builder と同じ Agent Space には入れない。
   コードレビューの設定とセキュリティ要件は Agent Space 単位で、その中のコードレビューを
   有効にした全リポジトリに効く。[docs/security-requirements.md](security-requirements.md)
   の 8 件は kakeibo 固有（`sub` によるスコープ、レシート画像の S3、Bedrock の IAM）なので、
   同居させると builder にも同じ要件が当たる
2. **GitHub App のリポジトリ選択に `sakekasu-kakeibo` を足す。** builder だけを選んで
   入れてあるなら kakeibo は見えない。自動では増えない。App 自体の入れ直しは要らない
   （新しく繋ぐ場合は Integrations → Add integration → GitHub → Install and authorize）
3. Agent Space の capabilities から「コードレビューを有効にする」を選び、
   リポジトリを繋いで Code review のトグルを入れる
4. セキュリティ要件を入れる。マネージドの要件（認証・認可、監視、暗号化、シークレット管理、
   情報保護）を有効にしたうえで、`docs/security-requirements.md` の 8 件をカスタム要件として足す

### 覚えておくこと

- コードレビューはプレビュー。コンソール側の作りは変わりうるので、上の手順は当てにしすぎない
- **CI の関門にはならない。** `test.yml` の `paths` にワークフロー自身を入れて「関門を外す変更を
  無検査で通さない」形にしているが、コードレビューはリポジトリの外で動くので同じ手が使えない。
  コンソールでトグルを切れば、リポジトリ側には何の跡も残らずに止まる
- 観点を変えるときは、`docs/security-requirements.md` を直してからコンソールに反映する。
  コンソールだけ直すと、次に誰かが読んだときに食い違う
- 費用はプレビューの間は無料。GA 後の料金は出てから確かめる

## PR の汎用コードレビュー（claude-code-action）

セキュリティは上の AWS Security Agent が見る。その担当外（ロジックのバグ、可読性、設計、
CLAUDE.md や steering の方針との食い違い）を埋めるのが `.github/workflows/claude-review.yml`。
[anthropics/claude-code-action](https://github.com/anthropics/claude-code-action) を使い、
PR の差分をレビューして指摘を PR のコメントに残す。CI は赤にしない。

**課金は Claude の Max 契約枠から引く。** Bedrock も従量課金の API キーも通さない。そのために
OAuth トークンを 1 本 repo に置く。デプロイで避けてきた「長命の鍵を置かない」とは折り合いが
つかないが、これは AWS の権限に触れる鍵ではなく Claude の契約に紐づくトークンで、従量課金も
発生しない、という判断で置いている。

### 鍵を置く

手元の Claude Code で `claude setup-token` を実行する。ブラウザで OAuth を通すと、長命の
トークンが 1 度だけ表示される。それを repo の Settings → Secrets and variables → Actions に
`CLAUDE_CODE_OAUTH_TOKEN` という名前で入れる。

- トークンは atsuhisa の Max 契約に紐づく。CI のレビューは、対話で Claude Code を使うときと
  同じ枠（5 時間・週次の上限）を食う。PR を出すのが本人と Claude だけなので量は少ない
- ログアウトや期限切れで無効になることがある。そのときは `claude setup-token` で取り直して
  Secret を更新する

### 挙動

- 指摘が出ても CI は赤にしない。コメントを残すだけ
- 走らせるのは `src` / `packages` / `infra` と設定ファイル、それにワークフロー自身。
  `docs` や `.kiro` だけの PR では走らない（Max の枠を無駄に使わない）
- 同じ PR に続けて push したら、前のレビューは打ち切る（`concurrency`）
- AWS Security Agent と役割が分かれている。片方はセキュリティ、こちらは汎用
- **`claude-review.yml` 自身を変える PR では、レビュー（Claude の実行）だけがスキップされる。**
  claude-code-action が、PR のワークフローを main の版と突き合わせ、違えば自分の実行を止める
  （改ざん防止）。効くのはこの Action の中だけで、**ジョブ自体は動く**。同一リポジトリの
  ブランチ PR では、checkout もトークンを見る step も、シークレット（`GITHUB_TOKEN`、
  `id-token`、`CLAUDE_CODE_OAUTH_TOKEN`）付きで走る。つまりワークフローを書き換える PR が
  安全になるわけではない。**信用できる PR にだけ使う**という前提は変わらない（このリポジトリは
  private で fork も無く、PR を出すのは本人と Claude だけ）。fork からの PR にはシークレットが
  渡らないので、鍵の有無を見る step でそのまま飛ぶ。track_progress の投稿を含む本来の動きは、
  main にマージされて初めて次の PR から効く
- `permissions` の `id-token: write` は、この検証とは別。claude-code-action が GitHub App
  トークンを OIDC で取得するのに要る

### `uses` の SHA を上げる

`@v1` タグの固定 SHA で留めてある。上げるときは手で書き換える。

```sh
git ls-remote https://github.com/anthropics/claude-code-action.git refs/tags/v1
```

## npm audit で残している指摘

ルート（画面）は 0 件。`infra/` には次の 8 件（high）が残るが、直さずに置いている（2026-10 時点）。

- `braces`（GHSA-vfj7-8cjw-p6xm）と、それを引く `micromatch` / `fast-glob` / `@aws-cdk/cdk-assets-lib` /
  `@aws-cdk/toolkit-lib` / `cdk-local` / `@go-to-k/cdkd`。`braces` は全バージョンが対象で修正版が無い。
  `npm audit fix --force` は cdkd を 0.169.0 へ下げようとするので打たない。cdkd 配下を overrides で
  動かすのもデプロイの挙動に響くので避けている
- `aws-cdk-lib` に同梱（bundled）された `brace-expansion`。最新の aws-cdk-lib でも同じ版が入っていて、
  同梱物には overrides が効かない

どれも合成とデプロイのときに手元か Actions で動くだけで、利用者のブラウザにも Lambda にも載らない。
渡るグロブはこちらのコードと cdk.json が決めたもので、外からの入力は入らないので、実害は無いと判断した。
aws-cdk-lib や cdkd を上げたときは `(cd infra && npm audit)` を取り直し、消えていればこの節を削る。
`npm audit fix` を `infra/` で打つと cdkd 配下（`cdk-local` など）まで上がるので、上げたいものだけを個別に入れる。

## よくある詰まり

### cdkd への移行が途中で止まった

deploy ワークフローが「cdkd の状態と CloudFormation のスタックの両方を持っています」で落ちたら、
`cdkd import --migrate-from-cloudformation` が状態を書いた後、CloudFormation のスタックを
消すところで止まっている。リソースは cdkd の状態に載っているので、残りは
CloudFormation のスタックの記録を消すだけでよい。

```sh
# 全リソースに Retain が付いているかを先に見る。付いていないものがあれば消さない
aws cloudformation get-template --stack-name <スタック名> --query 'TemplateBody' \
  | jq '.Resources | to_entries[] | select(.value.DeletionPolicy != "Retain") | .key'
aws cloudformation delete-stack --stack-name <スタック名>
```

Retain が付いていないリソースがあるときは、`delete-stack` を打つと AWS 上のリソースごと消える。
その場合は `npx cdkd import <スタック名> --migrate-from-cloudformation --force --yes` を
打ち直して、Retain を付けるところからやり直す。

### `cdkd deploy` が作成済みのはずのリソースを作ろうとする

cdkd の状態に載っていないリソースは、新規として扱われる。移行の前検査を通っていれば
起きないはずだが、起きたら `npx cdkd state resources <スタック名>` で状態に載っている
リソースを確かめ、足りないものを `npx cdkd import <スタック名> --resource <論理ID>=<物理ID>`
で取り込む。

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

### 認証アプリを失くしてサインインできない

ログインは共通ログインなので、MFA の登録も共通のユーザープール（`ap-northeast-1_yw1VDKtxW`）にある。
解除すると 4 アプリすべてに効く。管理者の操作で登録を外すと、次のログインでマネージドログインが
認証アプリの登録からやり直させる。

```sh
aws cognito-idp admin-set-user-mfa-preference \
  --user-pool-id ap-northeast-1_yw1VDKtxW \
  --username <共通プールのユーザー名> \
  --software-token-mfa-settings Enabled=false,PreferredMfa=false \
  --region ap-northeast-1
```

ユーザー名は「共通ログインへの切り替え（済み）」にある `list-users` で分かる。プール側は必須のままなので、
登録を外しても MFA なしでは入れない。パスワードは変わらない。

AWS に入る手段まで失うと手が無くなるので、認証アプリのバックアップ（1Password などの
同期するもの、または復旧コードの保管）は用意しておく。

### 画面が「Failed to fetch」のまま。CORS を直しても消えない

CORS の設定が正しく入っていても、preflight（ブラウザが本体の前に投げる OPTIONS）が
認証に掛かっていると同じ症状になる。切り分けはブラウザを介さず curl で見るのが早い。

```sh
api=$(aws cloudformation describe-stacks --stack-name sakekasu-kakeibo-dev-api \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text)
site=$(aws cloudformation describe-stacks --stack-name sakekasu-kakeibo-dev-site \
  --query "Stacks[0].Outputs[?OutputKey=='SiteUrl'].OutputValue" --output text)

curl -s -i -X OPTIONS "$api/snapshot" \
  -H "Origin: $site" \
  -H "Access-Control-Request-Method: GET" \
  -H "Access-Control-Request-Headers: authorization"
```

`204` が返れば preflight は通っている。`401` なら OPTIONS がオーソライザ付きのルートに
入っている。preflight に `Authorization` ヘッダは付かないので、通るはずがない。

```
HTTP/2 401
access-control-allow-origin: https://xxxxxxxx.cloudfront.net   ← CORS 自体は入っている
www-authenticate: Bearer
{"message":"Unauthorized"}
```

CORS のヘッダは付いたまま 401 になるのが分かりにくいところ。`AllowOrigins` を見ても
正しいので、設定を疑い続けると抜け出せない。

原因は `addRoutes` の `methods` に `ANY` を書くこと。`ANY` は OPTIONS も拾う。
メソッドを並べて書いて OPTIONS を含めなければ、CORS を設定した API Gateway が
preflight に直接応える。`infra/__tests__/stacks.test.ts` にルートキーを見る
テストを置いてある。

### 仮パスワードのメールが届かない

ユーザーは共通のユーザープールにあるので、作り方も仮パスワードの扱いも共通基盤の
`docs/identity.md` に従う。ここには詰まったときの見どころだけを書く。

**まず迷惑メールフォルダを見る。** ユーザープールに SES を繋いでいないので、送信元は
Cognito 既定の `no-reply@verificationemail.com` になり、迷惑メール扱いされやすい。

そこにも無ければ、利用者は本人なのでパスワードを直接入れてよい（共通プールは 16 文字以上）。

```sh
read -rs "?パスワード: " pw; echo   # bash なら read -rsp "パスワード: " pw; echo
aws cognito-idp admin-set-user-password \
  --user-pool-id ap-northeast-1_yw1VDKtxW \
  --username <共通プールのユーザー名> \
  --password "$pw" \
  --permanent \
  --region ap-northeast-1
unset pw
```

`--permanent` を付けなければ仮パスワード扱いになり、マネージドログインがパスワードの変更を求める。

## 監視

アラームは CloudWatch に置き、ALARM と OK（復旧）の両方を共通基盤のトピック
`sakekasu-integrated-alerts`（ap-northeast-1）へ送る。そこから Slack に流れる。
トピックと Slack の通知は共通基盤（sakekasu-integrated_environment）の持ち物で、作りと約束は
[共通基盤の docs/monitoring.md](https://github.com/yuuuuuuu168/sakekasu-integrated_environment/blob/main/docs/monitoring.md)
の「各アプリからアラームを送る」にある。

- トピックの ARN は `arn:aws:sns:ap-northeast-1:<アカウント ID>:sakekasu-integrated-alerts` と組み立てる。
  共通基盤のスタックの出力は参照しない（参照でつなぐと、向こうのスタックを作り直せなくなる）
- アラーム名は `sakekasu-kakeibo-` で始める。Slack の見出しのアプリ名はこの接頭辞から引かれる
- アラームは監視対象と同じスタック（api / data）に置く。監視用のスタックを分けると、関数やテーブルを
  スタック間の参照で渡すことになるため。作るのは `infra/lib/alarms.ts` の `SharedAlarms` で、
  名前の接頭辞とリージョンが外れていると合成が止まる
- 権限は足していない。トピックへの publish は共通基盤のトピックポリシーで許してあり、
  cdkd 用ロール（AdministratorAccess）はアラームとメトリクスフィルタを作れる

### アラーム一覧

`<env>` は `dev` / `prod`。どれも 5 分間の合計が 1 以上で鳴り、1 期間で判定する。
データが無い期間は `NOT_BREACHING`（起きたときだけ値が出る指標なので、使っていない夜中に鳴らさない）。

| アラーム名 | スタック | 見ているもの |
| --- | --- | --- |
| `sakekasu-kakeibo-<env>-api-errors` | api | API の Lambda の Errors |
| `sakekasu-kakeibo-<env>-ocr-receipt-errors` | api | OCR の Lambda の Errors |
| `sakekasu-kakeibo-<env>-classify-errors` | api | カテゴリ判定の Lambda の Errors |
| `sakekasu-kakeibo-<env>-monthly-report-errors` | api | 月次レポートの Lambda の Errors |
| `sakekasu-kakeibo-<env>-{api,ocr-receipt,classify,monthly-report}-throttles` | api | 上の 4 本の Throttles（4 個） |
| `sakekasu-kakeibo-<env>-api-5xx` | api | HTTP API の `5xx`（次元 `ApiId`） |
| `sakekasu-kakeibo-<env>-monthly-report-failures` | api | 月次レポートのログの `[monthly-report] failed`（メトリクスフィルタで数える） |
| `sakekasu-kakeibo-<env>-monthly-report-invocation-failures` | api | EventBridge の `FailedInvocations`（ルール `sakekasu-kakeibo-<env>-monthly-report`） |
| `sakekasu-kakeibo-<env>-dynamodb-read-throttles` | data | テーブルの `ReadThrottleEvents` |
| `sakekasu-kakeibo-<env>-dynamodb-write-throttles` | data | テーブルの `WriteThrottleEvents` |

読むときの注意。

- api / ocr-receipt / classify は例外を握って 500 / 502 を返す。処理の失敗は Lambda の Errors ではなく
  `api-5xx` に出る。Errors が鳴るのは、タイムアウト・メモリ不足・初期化の失敗など関数そのものが落ちたとき
- `api-5xx` は、OCR が読めない画像を受けたとき（502）と、カテゴリ判定の鍵が未設定のとき（502）にも鳴る
- 月次レポートは利用者ごとの失敗を握って正常終了するので、`monthly-report-errors` では拾えない。
  `monthly-report-failures` がその分を見る。ログの文言（`infra/lambda/monthly-report/index.ts`）を変えるときは、
  `api-stack.ts` のフィルタも合わせる
- 月 1 回の呼び出しが「来なかった」ことは見ていない。月に 1 点しか出ない指標を欠損で鳴らすと、
  残りの期間ずっと鳴り続けるため
- DynamoDB はオンデマンドなので容量の設定は無いが、急な増加では弾かれる。`ThrottledRequests` は
  操作ごとの次元しか持たないので、テーブル単位の Read/WriteThrottleEvents を見ている

### 届いているかを確かめる

アラームの状態ではなく、アクションの履歴を見る（読み取り専用のプロファイルで足りる）。
`Failed to execute action` が出ていれば、トピックポリシーで拒否されている。

```sh
aws cloudwatch describe-alarm-history --profile verify --region ap-northeast-1 \
  --alarm-name sakekasu-kakeibo-dev-api-5xx --history-item-type Action \
  --query 'AlarmHistoryItems[].[Timestamp,HistorySummary]'
```

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
| Secrets Manager | 月 0.4 ドル。シークレット 1 個ぶん |
| TypeSafe（Jev） | 入力 100 万トークンで 0.042 ドル、出力は無料。レシート 1 枚は 1,000 トークン未満 |
| Route53（ゾーンを新設した場合のみ） | 月 0.5 ドル |
| CloudWatch アラーム | 月 1.3 ドル。13 個 × 0.1 ドル（無料枠の 10 個はアカウント内のほかのアプリと分け合う） |

既存のゾーンを使うなら、アラームの 1.3 ドルが一番重く、Secrets Manager の 0.4 ドルが続く。
Bedrock の OCR がその次で、同時実行を 3 に絞ってあるので暴走しても天井がある。
カテゴリ判定は桁が 2 つ小さく、金額として数える意味がない。

## 消すとき

DynamoDB のテーブル、レシート用バケット、配信用バケットは
`RemovalPolicy.RETAIN` にしてある。`cdkd destroy` しても家計簿のデータは残る。
本当に消すなら、スタックを消した後にコンソールか CLI で個別に消す。
ログインに使っている共通のユーザープールは共通基盤の持ち物なので、ここからは消さない。
