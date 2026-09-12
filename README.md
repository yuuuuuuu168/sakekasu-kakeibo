# sakekasu-kakeibo

クレジットカードと PayPay の明細を取り込んで、カテゴリごとの上限と突き合わせ、月末に叱ってくれる家計簿。
`https://kakeibo.sakekasu-builder.com` で動かす。使うのは本人ひとり。

手入力をなるべくしないことを最優先にしている。困るのは明細に「どこで払ったか」しか書いていないことで、
コンビニの 1,200 円がおにぎりとティッシュペーパーのまま食費に落ちる。そこでレシートの写真を主軸に置いた。
撮ると品目と単価を読み取り、金額と日付で明細行に自動で突き合わせ、品目ごとにカテゴリを付ける。

## できること

- CSV と PDF の取り込み。Shift_JIS の CSV も読む。列の対応は自動で推定し、外したら画面で指定できる
- 店舗名からの自動分類。カテゴリを直すと「この店は今後もこれ」を覚える
- コンビニやドラッグストアのように複数カテゴリが混ざる店は「内訳待ち」として残る
- レシートの写真を Bedrock で読み、品目ごとに分けて明細に当てる
- カテゴリごとの上限と、月末の着地見込み
- 毎月 1 日に前月のレポートを作る。叱りは超過率で 5 段階

## 手元で動かす

AWS は要らない。データはブラウザの localStorage に入る。

```sh
npm install
npm run dev
```

## 構成

```
packages/core/   明細解析、店名の正規化、自動分類、レシートのマッチ、集計、叱り（AWS に依存しない純粋関数）
src/             画面（React 19 + Vite + Tailwind v4）
infra/           CDK（Cognito / DynamoDB / S3 / HTTP API / Lambda / CloudFront）
infra/lambda/    api, ocr-receipt, monthly-report
docs/            要件、設計、運用
```

`packages/core` は画面と Lambda の両方から同じコードが読まれる。月次レポートの集計が
画面と Lambda で食い違わないようにするため、ここを 2 回書かない。

## ドキュメント

- [docs/requirements.md](docs/requirements.md) 何を解きたいか、やらないこと
- [docs/design.md](docs/design.md) 構成、データモデル、分類とマッチの決め方、叱りの段階
- [docs/operations.md](docs/operations.md) 動かし方、デプロイ、費用の見込み

## 確認

```sh
npm run lint
npm run typecheck
npm test
cd infra && npm test
```
