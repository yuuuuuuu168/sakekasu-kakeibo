# japanese-guard

Claude Code の応答が英語に切り替わったら、ターンの終わりに日本語で書き直させる Stop フック。
[minorun365/claude-code-japanese-guard](https://github.com/minorun365/claude-code-japanese-guard) をそのまま同梱している。

## 出どころ

- 上流: https://github.com/minorun365/claude-code-japanese-guard
- コミット: [`930f05687d333b310740651f022c2b531b5a0aa7`](https://github.com/minorun365/claude-code-japanese-guard/tree/930f05687d333b310740651f022c2b531b5a0aa7)（2026-09-26）
- ライセンス: Apache License 2.0（`LICENSE` と `NOTICE` は上流のまま）

| このディレクトリ | 上流 | 手を入れたところ |
|---|---|---|
| `japanese-guard.py` | `hooks/japanese-guard.py` | なし |
| `test_japanese_guard.py` | `tests/test_japanese_guard.py` | 本体を探すパス（`HOOK`）だけ |
| `LICENSE` / `NOTICE` | 同名 | なし |

## なぜ `~/.claude/` ではなくリポジトリに置くか

上流の README は `~/.claude/hooks/` に置いて `~/.claude/settings.json` に登録する手順だが、
クラウドのセッションはコンテナが使い捨てなので、ホームに置いたものは次のセッションで消える。
そこでリポジトリに同梱し、`.claude/settings.json` の `hooks.Stop` から
`python3 "$CLAUDE_PROJECT_DIR"/scripts/japanese-guard/japanese-guard.py` で呼んでいる。

## 更新するとき

上流の新しいコミットから `hooks/japanese-guard.py` などを写し直し、テストの `HOOK` だけ
このディレクトリを指すように直して、上の表のコミットを書き換える。本体には手を入れない。

## テスト

```sh
python3 scripts/japanese-guard/test_japanese_guard.py
```

閾値は環境変数 `JAPANESE_GUARD_MIN_LATIN`（既定 25）と `JAPANESE_GUARD_RATIO`（既定 3）で変えられる。
