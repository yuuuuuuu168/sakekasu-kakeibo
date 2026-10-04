---
inclusion: always
---

# kakeibo.sakekasu-builder.com プロジェクト概要

## サービス概要

クレジットカードと PayPay の明細を取り込んで、カテゴリごとの上限と突き合わせ、月末に叱ってくれる家計簿。
利用者は本人ひとり。手入力をなるべくしないことを最優先にしている。

解きたい問題は「明細には *どこで払ったか* しか書いていない」こと。コンビニの 1,200 円が
おにぎりとティッシュペーパーのまま食費に落ちると、何に散財しているかが分からない。
そこでレシートの写真を主軸に置き、品目ごとにカテゴリを付ける。

最初の数か月は試行錯誤のフェーズで、カテゴリは後から動かす前提で作ってある。

## 機能一覧

| # | 機能 | 状態 |
|---|------|------|
| 1 | CSV / PDF の明細取り込み（Shift_JIS 対応、列の自動推定） | ✅ 実装済み |
| 2 | 店舗名の正規化と自動分類（初期搭載ルール + 学習 + AI 判定） | ✅ 実装済み |
| 3 | 内訳待ち（複数カテゴリが混ざる店の印） | ✅ 実装済み |
| 4 | レシート OCR と明細への自動マッチ | ✅ 実装済み |
| 5 | ワンタップ分割（レシートが無いとき） | ✅ 実装済み |
| 6 | カテゴリの追加・改名・統合・小カテゴリ（2 段） | ✅ 実装済み |
| 7 | カテゴリごとの月の上限と着地見込み | ✅ 実装済み |
| 8 | 月末の叱りレポート（5 段階） | ✅ 実装済み |
| 9 | 定期的な支払いの登録と、着地見込み・残り回数への反映 | ✅ 実装済み |
| 10 | 画像として出力された PDF の取り込み | 未着手 |
| 11 | 銀行・カード会社との自動連携 | やらない |
| 12 | 収入・資産の管理、複数人での共有 | やらない |

## 技術スタック

- **フレームワーク**: React 19 + TypeScript 5.8
- **ビルドツール**: Vite 7
- **スタイリング**: Tailwind CSS v4（`@theme` ディレクティブ、`tailwind.config.js` 不使用）
- **バックエンド**: AWS CDK（API Gateway HTTP API + Lambda + DynamoDB）
- **認証**: 4 アプリ共通の Amazon Cognito ユーザープール（sakekasu-integrated_environment）。
  マネージドログイン（`auth.sakekasu-builder.com`）へリダイレクトし、認可コード + PKCE で入る。
  値は `infra/cdk.json` の context `sharedAuth`。アプリ専用の旧プール（`-auth`）は外した
- **配信**: S3 + CloudFront（OAC）。セキュリティヘッダも CDK の中
- **デプロイ**: アプリ本体のスタックは cdkd（CloudFormation を通さない CDK のデプロイツール）で出す。
  cdkd 用ロールと Actions 用ロールのスタックだけは CloudFormation
- **AI**: Amazon Bedrock（Claude Haiku 4.5）※レシートの OCR、TypeSafe（Jev）※カテゴリ判定
- **テスト**: Vitest + Testing Library + fast-check（プロパティベーステスト）

UI コンポーネントのライブラリとルータは入れていない。画面が 6 枚しかないため。
ルータはハッシュだけで、CloudFront のリライト規則を要らなくしている。

上部のタブは使う順に レシート / 明細 / 明細取り込み / ダッシュボード / レポート の 5 枚。
既定の画面（`#/`）はレシート。カテゴリと上限、定期的な支払いの設定は
右上の歯車（`#/settings`）の中にある。

## プロジェクト構成

```
packages/core/     # AWS に依存しない純粋関数。画面と Lambda の両方から読む
  src/statement/   # CSV の解析・文字コード判定・列の推定・明細への正規化
  src/receipt/     # 品目のカテゴリ推定・内訳の分割・明細とのマッチ
  src/rules.ts     # 自動分類と初期搭載ルール
  src/classify.ts  # 大カテゴリ → 小カテゴリの 2 段判定（材料づくりと採否）
  src/recurring.ts # 定期支払いの発生回・残り回数・明細との突き合わせ
  src/budget.ts    # 月次の集計
  src/report.ts    # 叱りの生成
src/
  features/        # 機能ごとのディレクトリ（auth / receipts / transactions / import /
                   # dashboard / report / categories / recurring / settings）
  api/             # API クライアント（remote / local の 2 実装）とストア
  components/ui/   # 共通コンポーネント
infra/
  lib/             # CDK スタック（auth / data / api / site / cert）
  lambda/          # Lambda 関数（api, ocr-receipt, classify, monthly-report）
docs/              # 要件・設計・運用
```

## 開発ルール

- 新機能は `src/features/{feature-name}/` に配置する
- AWS に依存しないロジックは `packages/core` に置く。画面と Lambda で 2 回書かない
- テストは `__tests__/` に unit テストと property テスト（fast-check）を置く
- 内訳（`splits`）の合計は必ず明細の `amount` に一致する。触るのは `packages/core` の
  分割関数だけで、API の Lambda でも保存前に同じ検査をしている
- 叱りの文面は固定テンプレートから組む。LLM に書かせない（毎月言うことが変わると比較できない）
- カスタムリソース（`Custom::*`）を作る CDK の機能は使わない。CloudFormation から
  IMPORT できず退路を塞ぐため（`BucketDeployment` と `logRetention` が該当）。
  例外は証明書のクロスリージョン参照（`crossRegionReferences`）だけで、これは
  `Custom::CrossRegionExportWriter` と `Custom::CrossRegionExportReader` を 1 つずつ作る。
  避けるには証明書の ARN を手で context に貼る運用になり、その手間を毎回の環境構築で
  払い続けることになる。上の 2 つと違って代わりが無いので、ここだけ通した
- カテゴリの階層は 2 段まで（`parentId`）。上限と月次レポートは大カテゴリの単位で、
  小カテゴリの実績は親に寄せて数える
- カテゴリ判定（Jev）は無くても動くこと。ローカルモードでも、鍵が無くても、外が落ちても、
  キーワード表とルールの答えで進む。判定を必須の経路にしない
- 日本語 UI を基本とする

## デザインテーマ

検証済みの既定パレットをそのまま使う。上限の達成状況は status の 4 色で表し、
色だけで意味を持たせないようアイコンと文字を必ず添える。ダークモード対応（`prefers-color-scheme`）。
トークンは `src/index.css` の `@theme` で定義。
