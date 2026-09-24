#!/usr/bin/env bash
# CloudFormation で入れてあるアプリ本体のスタックを cdkd の管理へ移す。
#
# deploy ワークフローが cdkd deploy の手前で毎回呼ぶ。移し終えた後は何もせずに抜ける
# （冪等）。結果は GITHUB_OUTPUT の engine= に書く。
#
#   engine=cdkd  全スタックが cdkd の状態を持っている。cdkd deploy してよい
#   engine=cfn   移行の前検査で引っかかったので、何も変えていない。今回は cdk deploy で出す
#
# 守っている不変条件は 1 つ。「CloudFormation のスタックが残っていて、cdkd の状態が無い」
# スタックを cdkd deploy に渡さない。渡すと cdkd はそれを新規作成とみなし、同じ名前の
# テーブルやバケットで落ちるか、Cognito の UserPool のように名前が重複できるものは
# 2 つ目を黙って作る（利用者のアカウントが空の新しいプールに切り替わる）。
#
# 移行の手順。
#   1. 全スタックを `cdkd import --dry-run` で調べ、全リソースが取り込めると確かめる。
#      1 つでも取り込めないものがあれば、どのスタックにも手を付けずに engine=cfn で抜ける
#   2. 使う側から順に `cdkd import --migrate-from-cloudformation` で移す。
#      CloudFormation は、他のスタックが Fn::ImportValue で読んでいる export を持つ
#      スタックを消せない。site → api → cert → auth → data → dns の順なら、
#      消す時点でそのスタックを読む CloudFormation スタックが残っていない
#   3. 移した後に不変条件を確かめる。崩れていれば落とす（cdk deploy にも戻さない。
#      半分移った状態で CloudFormation 側を更新すると、どちらの管理か分からなくなる）
#
# 取り込みは AWS 上のリソースを消さない。cdkd が DeletionPolicy: Retain を全リソースに
# 付けてから CloudFormation のスタックを消すので、スタックの記録だけが無くなる。
set -euo pipefail

: "${TARGET_ENV:?TARGET_ENV を指定してください}"
: "${GITHUB_OUTPUT:=/dev/stdout}"

prefix="sakekasu-kakeibo-${TARGET_ENV}"
account="$(aws sts get-caller-identity --query Account --output text)"
state_bucket="cdkd-state-${account}"

# 使う側から順（理由は上）。スタック名とリージョンの組
stacks=(
  "${prefix}-site ap-northeast-1"
  "${prefix}-api ap-northeast-1"
  "${prefix}-cert us-east-1"
  "${prefix}-auth ap-northeast-1"
  "${prefix}-data ap-northeast-1"
  "${prefix}-dns ap-northeast-1"
)

# CloudFormation のスタックがあるか。無いときだけ false を返し、それ以外の失敗
# （権限、スロットリング）は握りつぶさずに落とす
cfn_exists() {
  local name="$1" region="$2" err
  if err="$(aws cloudformation describe-stacks --stack-name "$name" --region "$region" \
    --query 'Stacks[0].StackStatus' --output text 2>&1)"; then
    return 0
  fi
  if grep -q 'does not exist' <<<"$err"; then
    return 1
  fi
  echo "$err" >&2
  exit 1
}

cdkd_state_exists() {
  local name="$1" region="$2"
  aws s3api head-object --bucket "$state_bucket" --key "cdkd/${name}/${region}/state.json" >/dev/null 2>&1
}

# 取り込みが要るスタックを集める
pending=()
for entry in "${stacks[@]}"; do
  read -r name region <<<"$entry"
  if cfn_exists "$name" "$region"; then
    if cdkd_state_exists "$name" "$region"; then
      # 前回の移行で状態は書けたが、CloudFormation 側を消すところで止まった
      echo "::error::${name} は cdkd の状態と CloudFormation のスタックの両方を持っています。docs/operations.md の「cdkd への移行が途中で止まった」を見てください"
      exit 1
    fi
    pending+=("$entry")
  fi
done

if [ "${#pending[@]}" -eq 0 ]; then
  echo "移行が要るスタックはありません"
  echo 'engine=cdkd' >>"$GITHUB_OUTPUT"
  exit 0
fi

echo "cdkd へ移すスタック: ${pending[*]}"

# 1. 前検査。どのスタックにも手を付けない
ok=true
for entry in "${pending[@]}"; do
  read -r name _ <<<"$entry"
  echo "::group::cdkd import --dry-run ${name}"
  log="$(npx cdkd import "$name" --dry-run -c "env=${TARGET_ENV}" 2>&1)" || {
    echo "$log"
    echo "::endgroup::"
    echo "::warning::${name} の import --dry-run が失敗しました"
    ok=false
    continue
  }
  echo "$log"
  echo "::endgroup::"
  summary="$(grep -E 'Summary: [0-9]+ imported' <<<"$log" | tail -n 1 || true)"
  if ! grep -qE 'Summary: [1-9][0-9]* imported, 0 not found, 0 unsupported, 0 out of scope, 0 failed' <<<"$summary"; then
    echo "::warning::${name} に取り込めないリソースがあります: ${summary:-（Summary 行が見つかりません）}"
    ok=false
  fi
done

if [ "$ok" != true ]; then
  echo "::warning::cdkd への移行を見送り、今回は CloudFormation（cdk deploy）でデプロイします。スタックには手を付けていません"
  echo 'engine=cfn' >>"$GITHUB_OUTPUT"
  exit 0
fi

# 2. 移行
for entry in "${pending[@]}"; do
  read -r name _ <<<"$entry"
  echo "::group::cdkd import --migrate-from-cloudformation ${name}"
  npx cdkd import "$name" --migrate-from-cloudformation --yes -c "env=${TARGET_ENV}"
  echo "::endgroup::"
done

# 3. 不変条件の確認
for entry in "${stacks[@]}"; do
  read -r name region <<<"$entry"
  if cfn_exists "$name" "$region"; then
    echo "::error::${name} の CloudFormation スタックが残っています。cdkd deploy は打ちません"
    exit 1
  fi
done

echo 'engine=cdkd' >>"$GITHUB_OUTPUT"
