import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('aws-amplify/auth', () => ({
  fetchAuthSession: async () => ({ tokens: { idToken: { toString: () => 'id-token' } } }),
}));
vi.mock('../../config', () => ({ config: { apiUrl: 'https://api.example.com' } }));

const { analyzeReceipt, OCR_MAX_WAIT_MS, OCR_POLL_INTERVAL_MS } = await import('../remote');

type Call = { method: string; url: string };
const calls: Call[] = [];

/** 受け付けの後に返す GET の応答を順に並べる。並べた分を使い切ったら最後のものを返し続ける */
function serve(start: { status: number; body?: unknown }, polls: { status: number; body?: unknown }[]) {
  let index = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url });
      const reply = method === 'POST' ? start : polls[Math.min(index++, polls.length - 1)];
      return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status });
    }),
  );
}

const noWait = async () => {};
const DRAFT = { storeName: 'ローソン', date: '2026-10-10', total: 540, items: [], warnings: [] };

beforeEach(() => {
  calls.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('analyzeReceipt（受け付けてから結果を聞きに行く）', () => {
  it('pending の間は聞き続け、done で下書きを返す', async () => {
    serve({ status: 202, body: { jobId: 'job-1' } }, [
      { status: 200, body: { status: 'pending' } },
      { status: 200, body: { status: 'pending' } },
      { status: 200, body: { status: 'done', draft: DRAFT } },
    ]);

    await expect(analyzeReceipt({ key: 'receipts/u/a.jpg' }, noWait)).resolves.toEqual(DRAFT);
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'POST https://api.example.com/receipts/analyze',
      'GET https://api.example.com/receipts/analyze/job-1',
      'GET https://api.example.com/receipts/analyze/job-1',
      'GET https://api.example.com/receipts/analyze/job-1',
    ]);
  });

  it('failed はサーバの理由をそのまま投げる', async () => {
    serve({ status: 202, body: { jobId: 'job-1' } }, [{ status: 200, body: { status: 'failed', message: '画像として読めない形式です' } }]);
    await expect(analyzeReceipt({ key: 'receipts/u/a.jpg' }, noWait)).rejects.toThrow('画像として読めない形式です');
  });

  it('受け付けが jobId を返さなければ聞きに行かない', async () => {
    serve({ status: 403, body: { message: 'その画像は読めません' } }, []);
    await expect(analyzeReceipt({ key: 'receipts/other/a.jpg' }, noWait)).rejects.toThrow('403');
    expect(calls).toHaveLength(1);
  });

  it('ジョブが見つからなければ（404）諦める', async () => {
    serve({ status: 202, body: { jobId: 'job-1' } }, [{ status: 404, body: { message: 'not found' } }]);
    await expect(analyzeReceipt({ key: 'receipts/u/a.jpg' }, noWait)).rejects.toThrow('見つかりません');
  });

  it('上限まで pending なら諦める', async () => {
    serve({ status: 202, body: { jobId: 'job-1' } }, [{ status: 200, body: { status: 'pending' } }]);
    await expect(analyzeReceipt({ key: 'receipts/u/a.jpg' }, noWait)).rejects.toThrow('時間内に読み取れませんでした');
    expect(calls.filter((call) => call.method === 'GET')).toHaveLength(OCR_MAX_WAIT_MS / OCR_POLL_INTERVAL_MS);
  });
});
