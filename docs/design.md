# 設計

## 構成

```
ブラウザ (React + Vite)
  │  CSV/PDF はブラウザ内で解析。確定した明細だけを送る
  │  Cognito の JWT を Authorization ヘッダに付ける
  ▼
API Gateway (HTTP API) ── Cognito JWT オーソライザ
  ▼
Lambda (api)  ──▶ DynamoDB (シングルテーブル)
  │
  ├─▶ S3 (レシート画像)  … 署名付き URL を返すだけ。本体は通さない
  └─▶ Lambda (ocr-receipt) ──▶ Bedrock (Claude)

EventBridge (毎月1日 09:00 JST) ──▶ Lambda (monthly-report) ──▶ DynamoDB

S3 (静的サイト) ◀── CloudFront ◀── kakeibo.sakekasu-builder.com
```

sakekasu-builder は AppSync + GraphQL だが、こちらは API Gateway + Lambda 1 本にした。
理由は、家計簿側の操作が「明細を一括で入れる」「レシートを OCR する」「月次レポートを組む」のように
RPC の形をしていて、グラフで引く必要がないこと。試行錯誤フェーズはスキーマを何度も変えるので、
リゾルバを都度足すより、ルータ 1 枚で回したほうが速い。

フロントの配信は S3 + CloudFront。sakekasu-builder は Amplify Hosting だが、あちらの
`docs/amplify-exit.md` が「配信設定だけが IaC の外にある」ことを唯一の移行動機として挙げている。
新規に作るものを同じ状態から始める理由はないので、最初から CDK に載せる。セキュリティヘッダも
同じ 7 種を `ResponseHeadersPolicy` で入れてある。

配信物は GitHub Actions から `aws s3 sync` で置く。CDK の `BucketDeployment` は使わない
（`Custom::CDKBucketDeployment` というカスタムリソースが増え、あちらが #129 で消したものと同じ性質になる）。

カスタムリソースを作らない方針の例外が 1 つある。証明書は CloudFront の制約で us-east-1 に
置くしかなく、その ARN を配信スタックへ渡すのに `crossRegionReferences` を使っている。これが
`Custom::CrossRegionExportWriter`（証明書スタック側）と `Custom::CrossRegionExportReader`
（配信スタック側）を 1 つずつ作る。避ける方法は、証明書スタックを先に入れて出力の ARN を
手で context に貼ることだが、その手間を環境を作るたびに払うことになる。`BucketDeployment` と
`logRetention` は代わりがあって消せたのに対し、これには無いので通した。

## スタック

| スタック | 中身 |
| --- | --- |
| `sakekasu-kakeibo-{env}-auth` | Cognito UserPool、UserPoolClient。セルフサインアップは無効 |
| `sakekasu-kakeibo-{env}-data` | DynamoDB テーブル、レシート用 S3 バケット |
| `sakekasu-kakeibo-{env}-api` | HTTP API、api Lambda、ocr-receipt Lambda、monthly-report Lambda、EventBridge ルール |
| `sakekasu-kakeibo-{env}-site` | 静的サイト用 S3、CloudFront、ACM 証明書（us-east-1）、レスポンスヘッダポリシー |

デプロイ先は sakekasu-builder と同じアカウント（232791540685 / ap-northeast-1）。
リソース名の接頭辞で分離する。証明書だけは CloudFront の制約で us-east-1 に置く。

## データモデル

DynamoDB のシングルテーブル。`pk` はユーザー固定、`sk` で種別を分ける。

| 種別 | pk | sk | 主な属性 |
| --- | --- | --- | --- |
| 明細 | `USER#<sub>` | `TXN#<id>` | `date`, `amount`, `merchant`, `rawMerchant`, `source`, `splits`, `needsDetail`, `receiptId` |
| レシート | `USER#<sub>` | `RECEIPT#<id>` | `storeName`, `date`, `total`, `items`, `imageKey`, `txnId`, `status` |
| カテゴリ | `USER#<sub>` | `CONFIG#categories` | `categories`（配列） |
| ルール | `USER#<sub>` | `CONFIG#rules` | `rules`（配列） |
| 定期支払い | `USER#<sub>` | `CONFIG#recurring` | `recurring`（配列） |
| 予算 | `USER#<sub>` | `BUDGET#<YYYY-MM>` | `limits`（カテゴリ ID → 上限額） |
| 列マッピング | `USER#<sub>` | `MAPPING#<sourceId>` | `mapping`, `label`, `source` |
| レポート | `USER#<sub>` | `REPORT#<YYYY-MM>` | 生成済みの月次レポート本体 |

読み出しは `GET /snapshot` が 1 回のクエリでこの partition を全部返し、画面はそれをメモリに置いて
月やカテゴリで絞る。利用者 1 人で明細は年に千件ほど、JSON にして数百 KB なので、月ごとに
取り直すより速い。増えたら `sk` に日付を入れて範囲クエリに変える。そのときは ID の付け替えが
要るので、この判断はここに書いておく。

カテゴリ・ルール・定期支払いを 1 アイテムに配列で持っているのは、画面がいつも一覧まるごと保存するから。
1 件ずつアイテムにすると、削除と並べ替えのたびに差分を計算する処理が要る。

内訳（`splits`）は明細の中に配列で持つ。別アイテムに分けない。レシート 1 枚の品目は多くても数十行で
400KB には遠く、集計のたびに join するほうが高くつく。不変条件は「`splits` の合計が `amount` に一致」。
これは `packages/core` の分割関数だけが触り、プロパティテストで守る。

金額は円の整数。小数は使わない。

## API

HTTP API の経路は次のとおり。すべて Cognito の JWT オーソライザを通る。

| 経路 | すること |
| --- | --- |
| `GET /snapshot` | 明細・レシート・カテゴリ・ルール・予算・列マッピング・定期支払いを全部返す |
| `PUT /transactions` | 明細をまとめて書く（取り込み） |
| `PUT /transactions/{id}` | 明細 1 件を書き換える |
| `DELETE /transactions/{id}` | 明細 1 件を消す |
| `PUT /categories` `PUT /rules` `PUT /recurring` | 一覧を丸ごと保存する |
| `PUT /budgets/{month}` | その月の上限を保存する |
| `PUT /mappings/{sourceId}` | CSV の列の対応を保存する |
| `POST /uploads` | レシート画像の署名付き URL を返す |
| `POST /receipts/analyze` | 画像を OCR してレシートの下書きを返す（別の Lambda） |
| `PUT /receipts/{id}` `DELETE /receipts/{id}` | レシートを保存・削除する |
| `GET /reports/{month}` | 作っておいた月次レポートを返す |

書き込みは上書き（upsert）にしてある。同じ明細を二重に入れないための判定は取り込み画面側
（`mergeImported`）が済ませているので、サーバ側で条件付き書き込みをしていない。
ただし**内訳の合計が明細の金額に一致していること**だけは Lambda でも検査して、合わなければ 400 で返す。
ここが崩れたまま保存されると、カテゴリ別の集計が静かに狂って、後から原因が追えなくなる。

## 手元で動かすモード

`VITE_API_URL` などが渡されていないとき、画面は「ローカルモード」で動く。
データはブラウザの localStorage に入り、月次レポートもその場で組む。AWS を用意する前に
カテゴリの試行錯誤を始められるようにするため。OCR と画像の置き場所だけは代わりが無いので断る。

## 明細 ID の決め方

同じ明細を二重に取り込まないために、ID を内容から決める。

```
id = sha256(source + '|' + date + '|' + amount + '|' + normalizeMerchant(rawMerchant)).slice(0, 24)
```

同じ日に同じ店で同じ金額を 2 回使うと衝突する（自販機で 2 回買う等）。そこで取り込み時、
同一キーが同じバッチ内に複数あれば連番を足す。すでに保存済みのものは、取り込みし直すと上書きになる。
このとき内訳とレシートの紐付けは保持する。上書きで手作業の結果を消さない。

## 店舗名の正規化

明細の店舗名は表記が荒れている。`ｾﾌﾞﾝｲﾚﾋﾞﾝ/ｾﾌﾞﾝ-ｲﾘﾌﾟﾝ`、末尾の店舗番号、`AMAZON.CO.JP*M12AB3CD4` の
注文 ID など。正規化でやること。

1. 全角英数と半角カナを変換する（NFKC）
2. 大文字に寄せる
3. 記号と空白を落とす
4. 末尾の連番・注文 ID らしい部分（4 文字以上の英数字の塊）を落とす

正規化後の文字列でルールを引き、`merchant` として保存する。元の文字列は `rawMerchant` に残す。

## 初期カテゴリ

14 個。試行錯誤の出発点として、細かすぎず、内訳を見たときに後悔しない粒度を狙った。

`食費` `外食` `カフェ・嗜好品` `酒` `日用品` `衣類・美容` `交通` `通信` `住居・光熱` `医療`
`趣味・娯楽` `交際費` `サブスク` `未分類`

`酒` を独立させてあるのは sakekasu-builder と同じ理由。食費に混ぜると見えなくなる。
`カフェ・嗜好品` はコンビニのコーヒーや菓子が食費に紛れるのを防ぐため。どちらも、要らなければ統合する。

## 自動分類の優先順

1. レシートで確定した内訳。これが最強で、後から上書きされない
2. 利用者のルール（`priority` の降順）
3. 初期搭載ルール
4. 未分類

初期搭載ルールには `ambiguous: true` の印を持つものがある。コンビニ、ドラッグストア、スーパー、
Amazon、ホームセンター、ネットスーパー。これに当たった明細は、カテゴリを推定したうえで
`needsDetail: true` を立てる。ダッシュボードに「内訳待ち N 件」として出す。

## レシートと明細のマッチ

候補の条件は合計金額の完全一致のみ。日付と店舗名はスコアに使う。

```
score = 日付の近さ (同日 40, 1日差 30, 2日差 20, 3〜4日差 10)
      + 店舗名の一致度 (正規化後の前方一致・部分一致で 0〜40)
      + 内訳が未確定なら 20
```

スコア 70 以上の候補が 1 件だけなら自動で紐付ける。それ以外は候補を並べる。
候補が 0 件なら現金払いとみなし、レシート単体を支出として登録するか確認する。

カードの利用日と計上日のずれを 4 日にしたのは、国内のカードで実測 1〜3 日が多く、
週末を挟むと 4 日になるため。5 日以上離すと別の買い物を拾い始める。

## 定期支払いと着地見込み

`packages/core/src/recurring.ts` が、登録した定期支払いから「その月に発生する回」を組み立てる。
開始月から `intervalMonths` ごとに 1 回。回数か最終月が入っていればそこで止まる。引き落とし日が
その月に無ければ（2 月の 31 日）月末に丸める。

取り込んだ明細との突き合わせは、店舗名（`merchantPattern`、空なら `label`）を正規化した文字列が
明細の店舗名に含まれるかで絞り、金額が登録額の 1 割（最低 100 円）以内のものを当てる。
`variableAmount` を立てたものは金額を見ない。当たった回は明細の金額を使う。

着地見込みは `aggregateMonth` が次の式で出す。

```
見込み = round((実績 − 突き合った額) × ペース) + 突き合った額 + 未発生の定期支払い
```

素朴に「日割り + 定期支払いの合計」にすると、既に取り込まれている定期支払いを 2 回数える。
そこで、突き合った明細は日割りの対象から外し、その額をそのまま足し直す。定期支払いを 1 件も
登録していなければ第 1 項だけが残り、従来の式と同じになる。この不変条件はプロパティテストで守る。

月次レポート（`buildMonthlyReport`）には定期支払いを渡さない。締めた月は実績が出そろっていて
見込みが要らないうえ、固定費を叱っても行動が変わらないため。

## 叱りの段階

月の実績を上限と比べて 5 段階。判定は超過額の合計と、上限を超えたカテゴリの数で決める。

| 段階 | 条件 | 口調 |
| --- | --- | --- |
| 0 天晴れ | 全カテゴリが上限内で、合計が上限の 8 割以下 | 褒める |
| 1 よし | 全カテゴリが上限内 | 認める |
| 2 むむ | 超過が 1 カテゴリだけ、かつ合計超過が上限総額の 5% 以内 | 指摘する |
| 3 喝 | 超過が 2 カテゴリ以上、または合計超過が 5〜20% | 叱る |
| 4 激怒 | 合計超過が 20% 超、または単一カテゴリで上限の 2 倍超 | 本気で叱る |

文面は固定テンプレートに、超過の大きいカテゴリ名と金額を差し込む。段階が同じなら毎月同じ言い方に
なるので、先月より悪化したかが口調で分かる。

## パッケージ構成

```
packages/core/      明細解析、正規化、分類、マッチ、集計、叱り。AWS に依存しない純粋関数
src/                フロントエンド（React 19 + Vite + Tailwind v4）
infra/              CDK
infra/lambda/       api, ocr-receipt, monthly-report
```

`packages/core` はビルドしない。TypeScript のソースをそのまま公開し、Vite と esbuild（NodejsFunction）
の双方から読ませる。フロントの集計と Lambda の月次レポートで同じコードが走ることに意味があるので、
ここを 2 回書かない。

core にはテストを厚く置く。CSV の列推定、店舗名の正規化、内訳分割の不変条件、レシートのマッチ、
叱りの段階。ここが正しければ、残りは画面と配線になる。
