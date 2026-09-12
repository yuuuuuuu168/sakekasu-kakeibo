/**
 * 明細 ID を内容から決めるためのハッシュ。FNV-1a の 64bit。
 * 用途は重複排除のキーで、秘密の保護ではないので暗号学的な強度は要らない。
 * ブラウザの crypto.subtle は非同期でコアを純粋関数に保てないため使っていない。
 */

const OFFSET = 0xcbf29ce484222325n;
const PRIME = 0x100000001b3n;
const MASK = 0xffffffffffffffffn;

export function fnv1a64(input: string): string {
  let hash = OFFSET;
  const bytes = new TextEncoder().encode(input);
  for (const byte of bytes) {
    hash = ((hash ^ BigInt(byte)) * PRIME) & MASK;
  }
  return hash.toString(16).padStart(16, '0');
}
