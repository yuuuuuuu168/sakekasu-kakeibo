/*
 * Yahoo!メールの取得の進め方。AWS にも IMAP にも触らない純粋な処理。
 *
 * IMAP の UID は受信箱の中で増え続ける番号で、UIDVALIDITY が変わらない限り振り直されない。
 * 最後に送った UID を持っておき、それより大きいものだけを取りに行く。止まっていた間の分も、
 * 次の回から 1 回 MAX_PER_RUN 通ずつ追いつく。
 */

/** 1 回に送る数。止まっていた間に溜まった分は、5 分ごとの次の回へ回す */
export const MAX_PER_RUN = 50;
/** 認証の失敗がこの回数続いたら、試す間隔を空ける（Yahoo! 側にパスワードの総当たりと見られて止められないように） */
export const AUTH_BACKOFF_AFTER = 3;
export const AUTH_BACKOFF_MS = 60 * 60 * 1000;
/** 認証の失敗がこの回数続いたら、試さなかった回も含めて毎回「失敗が続いている」の行を出す（アラームが拾う） */
export const AUTH_ALERT_AFTER = 2;

export type RelayState = {
  /** UIDVALIDITY（IMAP では 64 ビットの数なので文字列で持つ） */
  uidValidity?: string;
  /** 最後に送った（または基準にした）UID */
  lastUid?: number;
  /** 続けて認証に失敗した回数。成功したら 0 に戻す */
  authFailures: number;
  /** 最後に認証に失敗した時刻（ISO 8601） */
  lastAuthFailureAt?: string;
};

export type RunPlan =
  /** 初めて、または UID が振り直された。今の最新を基準にして、過去のメールは送らない */
  | { kind: 'baseline'; lastUid: number; reason: '初回' | 'UIDVALIDITY が変わった' }
  /** この UID から先を取りに行く */
  | { kind: 'fetch'; afterUid: number };

export function planRun(state: RelayState, mailbox: { uidValidity: string; uidNext: number }): RunPlan {
  if (state.lastUid === undefined || state.uidValidity === undefined) {
    return { kind: 'baseline', lastUid: mailbox.uidNext - 1, reason: '初回' };
  }
  if (state.uidValidity !== mailbox.uidValidity) {
    // 振り直された番号では、どれが新着か分からない。全部を送り直すより、取りこぼしを人に知らせるほうを選ぶ
    return { kind: 'baseline', lastUid: mailbox.uidNext - 1, reason: 'UIDVALIDITY が変わった' };
  }
  return { kind: 'fetch', afterUid: state.lastUid };
}

/** 取りに行った UID の一覧から、今回送るものを選ぶ（古い順に MAX_PER_RUN まで） */
export function pickUids(uids: number[], afterUid: number): number[] {
  // `N:*` は N が最大の UID を超えていても最後の 1 通を返すので、ここで落とす
  return [...new Set(uids)].filter((uid) => uid > afterUid).sort((a, b) => a - b).slice(0, MAX_PER_RUN);
}

/** 今回ログインを試すか。失敗が続いていたら 1 時間に 1 回まで */
export function shouldTryLogin(state: RelayState, now: Date): boolean {
  if (state.authFailures < AUTH_BACKOFF_AFTER || !state.lastAuthFailureAt) return true;
  return now.getTime() - Date.parse(state.lastAuthFailureAt) >= AUTH_BACKOFF_MS;
}

/** Secrets Manager に入れる設定。`{ "user", "password", "forwardTo" }` */
export type RelayConfig = { user: string; password: string; forwardTo: string };

export function parseRelayConfig(text: string | undefined): RelayConfig | undefined {
  if (!text) return undefined;
  try {
    const value = JSON.parse(text) as Partial<RelayConfig> | null;
    if (
      typeof value?.user === 'string' &&
      value.user !== '' &&
      typeof value.password === 'string' &&
      value.password !== '' &&
      typeof value.forwardTo === 'string' &&
      /^[^@\s]+@[^@\s]+$/.test(value.forwardTo)
    ) {
      return { user: value.user, password: value.password, forwardTo: value.forwardTo };
    }
  } catch {
    // 作ったばかりのシークレット（乱数）は JSON ではない。未設定として扱う
  }
  return undefined;
}
