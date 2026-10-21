/**
 * 必須の環境変数を読む。無ければ読み込みの時点で落とし、設定漏れを最初の呼び出しで気づけるようにする。
 * 値は api-stack.ts が関数ごとに渡している。
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}
