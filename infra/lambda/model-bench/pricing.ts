import type { ClaudeUsage } from '../classify/claude';

/**
 * Claude API の 100 万トークンあたりの料金（ドル）。2026-10 の一般価格で、思考のトークンは出力に含まれて請求される。
 * 評価の予算（maxUsd）を数えるのに使うだけで、請求そのものは Claude Console の Usage が正しい。
 *
 * 表に無いモデル（出たばかりのモデルなど）は、呼び出しの price で渡す。黙って安い値で数えて
 * 予算を超えないよう、表にも price にも無いモデルは走らせない。
 */
export type Price = {
  input: number;
  output: number;
  /** 指定が無ければ入力の 1 割 */
  cacheRead?: number;
  /** 指定が無ければ入力の 1.25 倍（5 分のキャッシュの書き込み） */
  cacheWrite?: number;
};

export const PRICES: Record<string, Price> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  // 10 万トークンを超えるプロンプトは倍額になるが、レシート 1 枚ではそこに届かない
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
};

export function priceOf(model: string, override?: Price): Price | undefined {
  return override ?? PRICES[model];
}

/** 1 回の呼び出しのドル。思考のトークンは output に含まれているので足し直さない */
export function costUsd(usage: ClaudeUsage, price: Price): number {
  const cacheRead = price.cacheRead ?? price.input * 0.1;
  const cacheWrite = price.cacheWrite ?? price.input * 1.25;
  return (
    (usage.input * price.input + usage.output * price.output + usage.cacheRead * cacheRead + usage.cacheWrite * cacheWrite) /
    1_000_000
  );
}
