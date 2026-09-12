import { config } from '../config';
import { localApi } from './local';
import { remoteApi } from './remote';
import type { KakeiboApi } from './types';

export const api: KakeiboApi = config.mode === 'remote' ? remoteApi : localApi;
export * from './types';
