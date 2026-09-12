# sakekasu 家計簿 (kakeibo.sakekasu-builder.com)

クレジットカードと PayPay の明細を取り込んで、カテゴリごとの上限と突き合わせ、月末に叱ってくれる家計簿。手入力をなるべくしないことを最優先にしている。

困るのは明細に「どこで払ったか」しか書いていないこと。コンビニの 1,200 円がおにぎりとティッシュペーパーのまま食費に落ちる。そこでレシートの写真を主軸に置いた。撮ると品目と単価を読み取り、金額と日付で明細行に突き合わせ、品目ごとにカテゴリを付ける。

## 機能

ここに載っているものはすべて実装済み。これから作るものは [GitHub Issue](https://github.com/yuuuuuuu168/sakekasu-kakeibo/issues) で管理する。

### 取り込む

| 機能 | 補足 |
|------|------|
| CSV の取り込み | Shift_JIS と UTF-8 の両方。解析はブラウザの中だけで行い、確定した明細だけをサーバへ送る |
| 列の自動推定 | ヘッダ名と値の形から日付・店名・金額を当てる。金額の列が複数ある形式では「ご利用金額」を選ぶ。外したら画面で指定し直せて、指定はソースごとに覚える |
| ヘッダの無い CSV | 三井住友カードの古い形式など。値の形だけで列を当てる |
| 出金・入金が別列の形式 | PayPay など。入金は返金として負の金額で入る |
| PDF の取り込み | テキスト層から「日付 … 店名 … 金額」の行を起こす |
| 二重取り込みの防止 | 明細の ID を内容から決める。同じ CSV を 2 回落としても増えない。再取り込みで手作業の内訳も消えない |

### 分ける

| 機能 | 補足 |
|------|------|
| 店舗名の正規化 | 半角カナ・全角英数・店舗番号・Amazon の注文 ID を落として名寄せする |
| 自動分類 | 国内でよく出る店を 160 件ほど初期搭載。カテゴリを直すと「この店は今後もこれ」を覚える |
| 内訳待ち | コンビニ・ドラッグストア・スーパー・Amazon・居酒屋など、1 回の支払いに複数カテゴリが混ざる店に印を付ける。確定するまで画面に「この数字は甘い」と出続ける |
| レシート OCR | Bedrock（Claude Haiku 4.5）が店名・日付・合計・品目を読む。品目ごとのカテゴリも推定し、外したぶんは品目名の表で拾い直す |
| 明細との自動マッチ | 合計金額の一致を必須に、日付の近さと店名の近さでスコアを付ける。迷いの無い候補が 1 件だけなら自動で紐付け、それ以外は候補を並べる |
| ワンタップ分割 | レシートが無いとき用。1,200 円を 食費 800 / 日用品 400 に割る。均等割りもある |
| 現金払いの登録 | 対応する明細が無いレシートは、そのまま支出として登録できる |

### 見る・叱られる

| 機能 | 補足 |
|------|------|
| カテゴリごとの上限 | 月単位。前月からコピーできる |
| ダッシュボード | 支出・月末の着地見込み・超過額・内訳待ちの件数。カテゴリ別は棒で出し、超えたら上限の位置で区切る |
| 明細一覧 | 月・カテゴリ・内訳待ちで絞る。カテゴリの付け替えと内訳の分割はここから |
| カテゴリの改名と統合 | 統合すると過去の明細の内訳も付け替わる。最初の数か月で作り直す前提 |
| 月末の叱りレポート | 毎月 1 日に前月分を作る。超過率で 5 段階（天晴れ / よし / むむ / 喝 / 激怒） |
| 店舗別の集計 | 「何に散財しているか」はカテゴリより店で見たほうが早いことがある |

### アカウント・基盤

| 機能 | 補足 |
|------|------|
| Cognito 認証 | 利用者は本人ひとり。セルフサインアップは閉じ、ユーザーは手で 1 つ作る。MFA（TOTP）は任意 |
| データ保護 | DynamoDB の PITR、S3 の公開禁止と暗号化、4 つの主要リソースは `RemovalPolicy.RETAIN` |
| レシート画像の自動削除 | 90 日。OCR で品目を取り出した後の画像は残す意味が薄い |
| 配信 | S3 + CloudFront（OAC）。セキュリティヘッダも CDK の中に置いた |
| ローカルモード | AWS が無くても `npm run dev` で通しで動く。データは localStorage |
| PR ごとのテスト・lint・型検査 | GitHub Actions がフロントとインフラの 2 系統を並べて走らせる |

### これから

| 機能 | 状態 |
|------|------|
| 画像として出力された PDF の取り込み | 未着手。いまはその場で断って CSV を促す。レシート OCR とは出力の形が違うので、経路を分けて作ることになる |
| 銀行・カード会社との自動連携 | やらない。明細の手動アップロードで始める |
| 収入と資産の管理 | やらない。支出だけを見る |
| 複数人での共有 | やらない。世帯の概念を入れない |

## こだわりポイント

### 「内訳待ち」という状態を作った

この家計簿の主題は、コンビニの 1,200 円をおにぎりとティッシュペーパーに割ることにある。だから「分類できた」と「何を買ったか分かった」を別の状態として持たせた。

初期搭載のルールには `ambiguous` の印が付いたものがある。コンビニ、ドラッグストア、スーパー、Amazon、ホームセンター、居酒屋。これに当たった明細はカテゴリが付いたうえで `needsDetail` が立ち、レシートを当てるか内訳を分割するまで印が残る。ダッシュボードにも月次レポートにも「内訳が未確定の明細が N 件ある。この数字は甘く出ている」と出続ける。

分類を当てただけで満足しないための仕掛けで、放置しても嘘の数字を信じずに済む。

### レシートと明細の突き合わせは、金額の一致を必須にした

候補に入る条件は合計金額の完全一致のみ。日付と店名はスコアにしか使わない。家計簿で一番信用できる手がかりは金額だから。

日付のずれは前後 4 日まで見る。カードの利用日と計上日は国内で 1〜3 日ずれることが多く、週末を挟むと 4 日になる。5 日以上離すと別の買い物を拾い始める。

スコア 70 以上の候補が 1 件だけなら自動で紐付け、同点が並んだら人間に選ばせる。候補が 0 件なら現金払いとみなす。

### 内訳の合計は必ず明細の金額に一致する

`splits` の合計が親の `amount` と一致することを不変条件にした。ここが崩れるとカテゴリ別の集計が静かに狂い、後から原因が追えない。

守り方は 3 段。`packages/core` の分割関数だけが内訳に触る。その関数を fast-check のプロパティテストで殴る（任意の総額と任意の品目列で合計が一致すること）。そして API の Lambda でも保存前に同じ検査をして、合わなければ 400 で返す。

レシートの品目合計と請求額のずれ（消費税・値引き・ポイント）は、最大剰余法で品目に按分する。「調整」という架空の行を作らないのは、カテゴリ別の集計を歪めないため。

### 叱りの文面を LLM に書かせない

固定テンプレートから組んでいる。段階が同じなら毎月同じ言い方になるので、先月より悪化したかが口調で分かる。LLM に書かせると毎月言うことが変わって比較できないし、テストも書けない。

段階は超過額の合計と、上限を超えたカテゴリの数で決める。単一カテゴリで上限の 2 倍を超えたら、合計が収まっていても「激怒」にする。

### 配信を最初から IaC に載せた

sakekasu-builder は Amplify Hosting で配信しているが、あちらの [docs/amplify-exit.md](https://github.com/yuuuuuuu168/sakekasu-builder/blob/main/docs/amplify-exit.md) が「配信設定だけが IaC の外にある」ことを唯一の移行動機として挙げている。新しく作るものを同じ状態から始める理由が無いので、S3 + CloudFront を最初から CDK に置いた。セキュリティヘッダ 7 種も `ResponseHeadersPolicy` に入れてある。

配信物は GitHub Actions から `aws s3 sync` で置く。CDK の `BucketDeployment` は使わない。`Custom::CDKBucketDeployment` というカスタムリソースが増え、あちらが [#129](https://github.com/yuuuuuuu168/sakekasu-builder/issues/129) で 6 個消したのと同じ性質のものを持ち込むことになる。ロググループを `logRetention` で作らず明示しているのも同じ理由。

### Bedrock の IAM は 2 種類の ARN が要る

OCR のモデル ID とその IAM は、sakekasu-builder が同じアカウント（<アプリのアカウント ID> / ap-northeast-1）で実測したものを踏襲した。

`bedrock:InvokeModel` の認可は、クロスリージョン推論プロファイル本体と、振り先の foundation-model の**両方**を見る。プロファイルの ARN だけを許可すると、振り先に当たったリクエストだけが `AccessDeniedException` で落ちる。毎回落ちないので気づきにくい。モデルを差し替えるときは `aws bedrock list-inference-profiles` で振り先リージョンを取り直すこと。詳細は [infra/lib/api-stack.ts](infra/lib/api-stack.ts) のコメントにある。

## 技術スタック

- React 19 + TypeScript 5.8
- Vite 7
- Tailwind CSS v4（`@theme` ディレクティブ、`tailwind.config.js` 不使用）
- AWS CDK（API Gateway HTTP API + Lambda + DynamoDB）
- Amazon Cognito（UserPool）
- AWS S3 + CloudFront（フロントの配信、レシート画像の保管）
- Amazon Bedrock（Claude Haiku 4.5）※レシートの OCR
- EventBridge（毎月 1 日のレポート生成）
- pdfjs-dist（PDF のテキスト抽出。動的 import で初回表示に載せない）
- Vitest + Testing Library + fast-check（コア・画面・インフラ）

UI コンポーネントのライブラリとルータは入れていない。画面が 6 枚で、必要なのがボタンと入力とダイアログだけなので、`src/components/ui/` に直接書いた。ルータをハッシュだけにしてあるのは、CloudFront のリライト規則が要らなくなるため（`#` 以降はサーバへ行かない）。

## プロジェクト構成

```
packages/core/     # AWS に依存しない純粋関数。画面と Lambda の両方から読む
  src/
    statement/     # CSV の解析・文字コード判定・列の推定・明細への正規化
    receipt/       # 品目のカテゴリ推定・内訳の分割・明細とのマッチ
    rules.ts       # 店舗名からの自動分類と初期搭載ルール
    merchant.ts    # 店舗名の正規化と近さの計算
    budget.ts      # 月次の集計と着地見込み
    report.ts      # 月次レポートと叱りの生成
src/
  features/
    auth/          # サインイン（Cognito）
    dashboard/     # ダッシュボード
    import/        # 明細の取り込み（CSV / PDF）
    transactions/  # 明細一覧と内訳の分割
    receipts/      # レシートの読み取りと明細への紐付け
    categories/    # カテゴリと上限
    report/        # 月末の叱りレポート
  api/             # API クライアント（remote / local の 2 実装）とストア
  components/ui/   # Card / Button / Meter / StatTile / Dialog など
infra/
  lib/             # CDK スタック（auth / data / api / site / cert）
  lambda/          # Lambda 関数（api, ocr-receipt, monthly-report）
docs/              # 要件・設計・運用
.kiro/steering/    # プロジェクトの前提（Claude Code が常に読む）
.github/           # GitHub Actions（test / deploy）
```

`packages/core` はビルドしない。TypeScript のソースをそのまま公開し、Vite と esbuild（NodejsFunction）の双方から読ませる。月次レポートの集計が画面と Lambda で食い違わないようにするため、ここを 2 回書かない。

## ドキュメント

| ドキュメント | 内容 |
|------------|------|
| [docs/requirements.md](docs/requirements.md) | 何を解きたいか、機能要件、非機能要件、やらないこと |
| [docs/design.md](docs/design.md) | 構成、スタック、データモデル、API、分類とマッチの決め方、叱りの段階 |
| [docs/operations.md](docs/operations.md) | 手元での動かし方、デプロイ、証明書とドメインの 3 通り、費用の目安 |
| [CLAUDE.md](CLAUDE.md) | 開発の進め方（ブランチ運用・AWS 確認の認証フロー） |

## セットアップ

```bash
# フロントエンド。AWS は要らない。データはブラウザの localStorage に入る
npm install
npm run dev

# インフラ（CDK）※差分の確認まで
cd infra
npm install
AWS_PROFILE=sakekasu-builder npx cdk diff -c env=dev
```

CSV の取り込み、自動分類、内訳の分割、上限の設定、月次レポートまでローカルモードで通しで動く。カテゴリの試行錯誤はこのモードで始められる。OCR と画像の保存だけ AWS が必要。

## デプロイ

初回は手元から入れる。手順は [docs/operations.md](docs/operations.md) にある。

```bash
cd infra
npx cdk deploy --all -c env=dev
```

スタックは 5 つ。`-auth` `-data` `-api` `-site` が ap-northeast-1 で、証明書の `-cert` だけが CloudFront の制約で us-east-1 に立つ。

`sakekasu-builder.com` のゾーンは Route53 にあり、ゾーン ID を `infra/cdk.json` の context に書いてある。証明書の発行、DNS 検証、`kakeibo.sakekasu-builder.com` のエイリアスレコードまで CDK がやるので、DNS の手作業は無い。

2 回目以降は `.github/workflows/deploy.yml` を手で起動する。使う前にリポジトリ変数 `AWS_DEPLOY_ROLE_ARN` に、GitHub OIDC で引き受けられるロールの ARN を入れておく。sakekasu-builder にも同じ仕組みのスタックがあるが、あちらのロールは信頼ポリシーが `yuuuuuuu168/sakekasu-builder` に絞られているので、このリポジトリからは引き受けられない。

## テスト

```bash
# コアのロジックと画面（Vitest）
npm run lint
npm run typecheck
npm test

# インフラ（CDK のアサーションと Lambda の単体テスト）
cd infra
npm test
```

同じものを PR とマージのたびに GitHub Actions が走らせる（`.github/workflows/test.yml`）。フロントとインフラを別のジョブに分けてあるのは、片方が落ちてももう片方の結果が残るようにするため。

テストは `packages/core` に厚く置いている。CSV の列推定、店舗名の正規化、内訳分割の不変条件、レシートのマッチ、叱りの段階。ここが正しければ、残りは画面と配線になる。

## デザイン

検証済みの既定パレットをそのまま使っている。上限の達成状況は status の 4 色（good / warning / serious / critical）で表し、色だけで意味を持たせないようアイコンと「余裕あり / 超過」の文字を必ず添える。金額の棒は単一色相の表現で、系列ごとの色分けはしない。

ダークモードは OS の設定に追従する（`prefers-color-scheme`）。トークンは `src/index.css` の `@theme` で定義。金額の桁が縦に揃わないと比べられないので、表と目盛りだけ `font-variant-numeric: tabular-nums` にしてある。
