/** テストでは Cognito を呼ばない。画面の分岐だけ確かめられれば足りる */
import { vi } from 'vitest';

export const signInWithRedirect = vi.fn(async () => undefined);
export const signOut = vi.fn(async () => undefined);
export const getCurrentUser = vi.fn(async () => ({ username: 'tester', userId: 'test-sub' }));
export const fetchAuthSession = vi.fn(async () => ({ tokens: { idToken: { toString: () => 'dummy-token' } } }));
