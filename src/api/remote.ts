import { fetchAuthSession } from 'aws-amplify/auth';
import type {
  Budget,
  Category,
  CategoryRule,
  ClassifyTarget,
  MonthlyReport,
  Receipt,
  RecurringPayment,
  Transaction,
  Verdict,
} from '@kakeibo/core';
import { config } from '../config';
import type { KakeiboApi, ReceiptDraft, SavedMapping, Snapshot, UploadTarget } from './types';

async function authorization(): Promise<string> {
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();
  if (!token) throw new Error('サインインが切れています。もう一度サインインしてください。');
  return `Bearer ${token}`;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${config.apiUrl}${path}`, {
    method,
    headers: {
      Authorization: await authorization(),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  if (response.status === 404) return undefined as T;
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`API がエラーを返しました (${response.status}) ${detail.slice(0, 200)}`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const remoteApi: KakeiboApi = {
  mode: 'remote',

  loadSnapshot: () => request<Snapshot>('GET', '/snapshot'),
  putTransactions: (transactions: Transaction[]) => request<void>('PUT', '/transactions', { transactions }),
  updateTransaction: (transaction: Transaction) => request<void>('PUT', `/transactions/${transaction.id}`, transaction),
  deleteTransaction: (id: string) => request<void>('DELETE', `/transactions/${encodeURIComponent(id)}`),
  putCategories: (categories: Category[]) => request<void>('PUT', '/categories', { categories }),
  putRules: (rules: CategoryRule[]) => request<void>('PUT', '/rules', { rules }),
  putRecurring: (recurring: RecurringPayment[]) => request<void>('PUT', '/recurring', { recurring }),
  putBudget: (budget: Budget) => request<void>('PUT', `/budgets/${budget.month}`, budget),
  putMapping: (mapping: SavedMapping) => request<void>('PUT', `/mappings/${encodeURIComponent(mapping.sourceId)}`, mapping),
  putReceipt: (receipt: Receipt) => request<void>('PUT', `/receipts/${encodeURIComponent(receipt.id)}`, receipt),
  deleteReceipt: (id: string) => request<void>('DELETE', `/receipts/${encodeURIComponent(id)}`),
  requestUpload: (contentType: string) => request<UploadTarget>('POST', '/uploads', { contentType }),
  analyzeReceipt: (input: { key?: string; keys?: string[]; dataUrl?: string }) => analyzeReceipt(input),
  classify: async (target: ClassifyTarget) => {
    const result = await request<{ verdicts?: Record<string, Verdict> }>('POST', '/classify', target);
    return result?.verdicts ?? {};
  },
  getReport: (month: string) => request<MonthlyReport | undefined>('GET', `/reports/${month}`),
};

/** 読み取りの結果を聞きに行く間隔。いまの読み取りは 1 枚で 2〜13 秒かかる */
export const OCR_POLL_INTERVAL_MS = 2_000;
/**
 * ここまで待って終わらなければ諦める。サーバ側でも、読み取りの Lambda のタイムアウトを過ぎた
 * ジョブは failed で返す（infra/lambda/shared/ocr-job.ts の OCR_JOB_STALE_MS）。これはその保険。
 */
export const OCR_MAX_WAIT_MS = 300_000;

type OcrJobResponse =
  | { status: 'pending' }
  | { status: 'done'; draft: ReceiptDraft }
  | { status: 'failed'; message?: string };

/**
 * レシートの読み取り。受け付けてもらった jobId で、結果が出るまで聞きに行く。
 * 読み取りは API Gateway の 30 秒を超えうるので、1 回のリクエストでは待たない。
 * `wait` はテストから待ち時間を飛ばすための差し替え口。
 */
export async function analyzeReceipt(
  input: { key?: string; keys?: string[]; dataUrl?: string },
  wait: (ms: number) => Promise<void> = sleep,
): Promise<ReceiptDraft> {
  const started = await request<{ jobId?: string } | undefined>('POST', '/receipts/analyze', input);
  const jobId = started?.jobId;
  if (!jobId) throw new Error('読み取りを受け付けてもらえませんでした');

  for (let waited = 0; waited < OCR_MAX_WAIT_MS; waited += OCR_POLL_INTERVAL_MS) {
    await wait(OCR_POLL_INTERVAL_MS);
    const job = await request<OcrJobResponse | undefined>('GET', `/receipts/analyze/${encodeURIComponent(jobId)}`);
    if (!job) throw new Error('読み取りの受付が見つかりません');
    if (job.status === 'done') return job.draft;
    if (job.status === 'failed') throw new Error(job.message || 'レシートの読み取りに失敗しました');
  }
  throw new Error('時間内に読み取れませんでした。もう一度お試しください');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 署名付き URL へ画像を直接置く。本体は API を通さない。fetch は送った量を教えてくれないので XMLHttpRequest で送り、
 * onProgress に 0〜1 を渡す。回線の遅いところで「本当に送れているのか」を画面に出すため。
 */
export function uploadToS3(target: UploadTarget, file: Blob, onProgress?: (ratio: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', target.uploadUrl);
    xhr.setRequestHeader('Content-Type', file.type);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(1);
        resolve();
      } else {
        reject(new Error(`画像のアップロードに失敗しました (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error('画像のアップロードに失敗しました。電波の届くところでもう一度お試しください。'));
    xhr.send(file);
  });
}
