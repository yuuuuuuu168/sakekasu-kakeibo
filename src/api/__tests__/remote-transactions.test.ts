import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_TRANSACTIONS_PER_REQUEST, type Transaction } from '@kakeibo/core';

vi.mock('aws-amplify/auth', () => ({
  fetchAuthSession: async () => ({ tokens: { idToken: { toString: () => 'id-token' } } }),
}));
vi.mock('../../config', () => ({ config: { apiUrl: 'https://api.example.com' } }));

const { remoteApi } = await import('../remote');

type Call = { method: string; url: string; body?: { transactions?: Transaction[] } };
const calls: Call[] = [];

function txn(id: string): Transaction {
  return {
    id,
    date: '2026-09-01',
    amount: 100,
    rawMerchant: 'ローソン',
    merchant: 'ローソン',
    source: 'credit',
    sourceLabel: 'クレジットカード',
    splits: [{ id: `${id}-1`, amount: 100, categoryId: 'food', origin: 'rule' }],
    needsDetail: false,
  };
}

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ method: init.method ?? 'GET', url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(null, { status: 204 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('remoteApi の明細', () => {
  it('上限を超える明細は、上限ずつに分けて送る', async () => {
    const transactions = Array.from({ length: MAX_TRANSACTIONS_PER_REQUEST + 1 }, (_, index) => txn(`t${index}`));

    await remoteApi.putTransactions(transactions);

    expect(calls.map((call) => call.body?.transactions?.length)).toEqual([MAX_TRANSACTIONS_PER_REQUEST, 1]);
    expect(calls.flatMap((call) => call.body?.transactions ?? []).map((item) => item.id)).toEqual(
      transactions.map((item) => item.id),
    );
  });

  it('1 件の更新でも id をパスに入れるときはエンコードする', async () => {
    await remoteApi.updateTransaction(txn('credit/2026#1'));

    expect(calls[0]).toMatchObject({ method: 'PUT', url: 'https://api.example.com/transactions/credit%2F2026%231' });
  });
});
