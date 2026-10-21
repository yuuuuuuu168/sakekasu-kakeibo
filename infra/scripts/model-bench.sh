#!/usr/bin/env bash
# モデルの評価（infra/lambda/model-bench）を、比べたい組の一式ぶん非同期で積む。
# 手順と結果の読み方は docs/operations.md の「モデルを比べる」にある。
#
#   bash infra/scripts/model-bench.sh [env] [OCR の枚数] [判定の枚数]
#
# プロファイルは AWS_PROFILE（既定 sakekasu-builder）。SSO の認証が切れていれば、
# 先に aws sso login を打ってブラウザでの承認を待つ。関数がまだ無ければ（デプロイ前）、何も積まずに止まる。
#
# 関数の同時実行は 1 なので、積んだ順に 1 本ずつ流れる。各組の maxUsd の合計は 48 ドルで、
# Claude Console のワークスペースの利用上限（50 ドル）の内側に収めてある。上限に当たった組は
# その場で止まり（[bench] summary の stopped が spend_limit）、後の組も同じ理由ですぐ止まる。
#
# Lambda の呼び出しは変更の操作なので、確認用のプロファイル（verify）では打てない。
set -euo pipefail

env_name="${1:-dev}"
ocr_limit="${2:-60}"
classify_limit="${3:-100}"
function_name="sakekasu-kakeibo-${env_name}-model-bench"
export AWS_PROFILE="${AWS_PROFILE:-sakekasu-builder}"
export AWS_REGION="${AWS_REGION:-ap-northeast-1}"

if ! aws sts get-caller-identity >/dev/null 2>&1; then
  echo "AWS の認証が切れている（プロファイル ${AWS_PROFILE}）。ログインする。"
  aws sso login --profile "$AWS_PROFILE"
fi
echo "認証: $(aws sts get-caller-identity --query Arn --output text)"

if ! aws lambda get-function --function-name "$function_name" --query Configuration.FunctionName --output text >/dev/null 2>&1; then
  echo "関数 ${function_name} が見つからない。PR をマージしてデプロイが終わってから打つ。" >&2
  exit 1
fi

# 仕事 モデル effort 予算（ドル）
plan=(
  "ocr claude-sonnet-5-5 low 3"
  "ocr claude-haiku-5-5 low 1"
  "ocr claude-opus-5-5 low 5"
  "ocr claude-opus-5-5 medium 6"
  "ocr claude-fable-5-1 low 10"
  "ocr claude-fable-5-1 medium 12"
  "classify keywords low 0"
  "classify jev low 0"
  "classify claude-haiku-5-5 low 1"
  "classify claude-sonnet-5-5 low 2"
  "classify claude-opus-5-5 low 3"
  "classify claude-fable-5-1 low 5"
)

for entry in "${plan[@]}"; do
  read -r task model effort max_usd <<<"$entry"
  limit=$([ "$task" = ocr ] && echo "$ocr_limit" || echo "$classify_limit")
  payload=$(printf '{"task":"%s","model":"%s","effort":"%s","limit":%d,"maxUsd":%s}' \
    "$task" "$model" "$effort" "$limit" "$max_usd")
  echo "積む: $payload"
  aws lambda invoke --function-name "$function_name" --invocation-type Event \
    --cli-binary-format raw-in-base64-out --payload "$payload" /dev/null >/dev/null
done

echo "積み終えた。結果は CloudWatch Logs の /aws/lambda/${function_name} に [bench] summary として出る。"
