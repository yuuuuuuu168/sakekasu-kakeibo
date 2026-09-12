import { fetchAuthSession } from 'aws-amplify/auth';
import type { Budget, Category, CategoryRule, MonthlyReport, Receipt, Transaction } from '@kakeibo/core';
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
  putBudget: (budget: Budget) => request<void>('PUT', `/budgets/${budget.month}`, budget),
  putMapping: (mapping: SavedMapping) => request<void>('PUT', `/mappings/${encodeURIComponent(mapping.sourceId)}`, mapping),
  putReceipt: (receipt: Receipt) => request<void>('PUT', `/receipts/${encodeURIComponent(receipt.id)}`, receipt),
  deleteReceipt: (id: string) => request<void>('DELETE', `/receipts/${encodeURIComponent(id)}`),
  requestUpload: (contentType: string) => request<UploadTarget>('POST', '/uploads', { contentType }),
  analyzeReceipt: (input: { key?: string; dataUrl?: string }) => request<ReceiptDraft>('POST', '/receipts/analyze', input),
  getReport: (month: string) => request<MonthlyReport | undefined>('GET', `/reports/${month}`),
};

/** 署名付き URL へ画像を直接置く。本体は API を通さない */
export async function uploadToS3(target: UploadTarget, file: Blob): Promise<void> {
  const response = await fetch(target.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': file.type },
    body: file,
  });
  if (!response.ok) throw new Error(`画像のアップロードに失敗しました (${response.status})`);
}
