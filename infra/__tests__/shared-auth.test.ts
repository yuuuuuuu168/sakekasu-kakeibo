import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSharedAuth, userPoolRegion } from '../lib/shared-auth';

const valid = { domain: 'auth.example.com', userPoolId: 'ap-northeast-1_AbC123', clientId: 'abc123def456' };

describe('parseSharedAuth', () => {
  it('3 つがそろっていればそのまま返す', () => {
    expect(parseSharedAuth(valid)).toEqual(valid);
  });

  /* 無いまま合成が通ると、空の値で画面が作られ、黙ってローカルモードで配信されてしまう */
  it('無ければ落とす', () => {
    expect(() => parseSharedAuth(undefined)).toThrow(/sharedAuth/);
    expect(() => parseSharedAuth('auth.example.com')).toThrow(/sharedAuth/);
  });

  it('ドメインに https:// が付いていたら落とす（画面側で付けるため二重になる）', () => {
    expect(() => parseSharedAuth({ ...valid, domain: 'https://auth.example.com' })).toThrow(/domain/);
  });

  it('ユーザープール ID やクライアント ID の形が違えば落とす', () => {
    expect(() => parseSharedAuth({ ...valid, userPoolId: 'AbC123' })).toThrow(/userPoolId/);
    expect(() => parseSharedAuth({ ...valid, clientId: '' })).toThrow(/clientId/);
  });

  /* 合成の時点で読むのは cdk.json の値。ここで形を確かめておけば、書き間違いを PR で止められる */
  it('cdk.json に書いた値が通る', () => {
    const cdkJson = JSON.parse(readFileSync(new URL('../cdk.json', import.meta.url), 'utf-8')) as {
      context: Record<string, unknown>;
    };
    expect(() => parseSharedAuth(cdkJson.context.sharedAuth)).not.toThrow();
  });
});

describe('userPoolRegion', () => {
  it('ID の _ より前をリージョンとして返す', () => {
    expect(userPoolRegion('ap-northeast-1_AbC123')).toBe('ap-northeast-1');
  });
});
