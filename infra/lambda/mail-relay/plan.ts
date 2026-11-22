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

/** フォルダ 1 つぶんの進み具合 */
export type FolderState = {
  /** UIDVALIDITY（IMAP では 64 ビットの数なので文字列で持つ） */
  uidValidity: string;
  /** 最後に送った（または基準にした）UID */
  lastUid: number;
};

export type RelayState = {
  /** フォルダ（IMAP のパス）ごとの進み具合。初めて見るフォルダはここに無い */
  folders: Record<string, FolderState>;
  /** 続けて認証に失敗した回数。成功したら 0 に戻す */
  authFailures: number;
  /** 最後に認証に失敗した時刻（ISO 8601） */
  lastAuthFailureAt?: string;
};

/**
 * 保存した行を読む。受信箱しか見ていなかった頃の行（uidValidity と lastUid を直に持つ）は、受信箱の進み具合として読み替える
 */
export function stateFromItem(item: Record<string, unknown> | undefined): RelayState {
  const folders: Record<string, FolderState> = {};
  const saved = item?.folders;
  if (saved && typeof saved === 'object') {
    for (const [path, value] of Object.entries(saved as Record<string, unknown>)) {
      const folder = value as Partial<FolderState> | null;
      if (typeof folder?.uidValidity === 'string' && typeof folder.lastUid === 'number') {
        folders[path] = { uidValidity: folder.uidValidity, lastUid: folder.lastUid };
      }
    }
  } else if (typeof item?.uidValidity === 'string' && typeof item.lastUid === 'number') {
    folders.INBOX = { uidValidity: item.uidValidity, lastUid: item.lastUid };
  }
  return {
    folders,
    authFailures: typeof item?.authFailures === 'number' ? item.authFailures : 0,
    ...(typeof item?.lastAuthFailureAt === 'string' ? { lastAuthFailureAt: item.lastAuthFailureAt } : {}),
  };
}

export type RunPlan =
  /** 初めて見るフォルダか、UID が振り直された。今の最新を基準にして、過去のメールは送らない */
  | { kind: 'baseline'; lastUid: number; reason: '初回' | 'UIDVALIDITY が変わった' }
  /** この UID から先を取りに行く */
  | { kind: 'fetch'; afterUid: number };

export function planRun(folder: FolderState | undefined, mailbox: { uidValidity: string; uidNext: number }): RunPlan {
  if (!folder) return { kind: 'baseline', lastUid: mailbox.uidNext - 1, reason: '初回' };
  if (folder.uidValidity !== mailbox.uidValidity) {
    // 振り直された番号では、どれが新着か分からない。全部を送り直すより、取りこぼしを人に知らせるほうを選ぶ
    return { kind: 'baseline', lastUid: mailbox.uidNext - 1, reason: 'UIDVALIDITY が変わった' };
  }
  return { kind: 'fetch', afterUid: folder.lastUid };
}

/** 取りに行った UID の一覧から、今回送るものを選ぶ（古い順に limit まで） */
export function pickUids(uids: number[], afterUid: number, limit = MAX_PER_RUN): number[] {
  // `N:*` は N が最大の UID を超えていても最後の 1 通を返すので、ここで落とす
  return [...new Set(uids)].filter((uid) => uid > afterUid).sort((a, b) => a - b).slice(0, Math.max(0, limit));
}

/**
 * Yahoo! に届いてからこれより経ったメールは、新着に見えても送らない。
 * IMAP ではメールを別のフォルダへ移すと、移した先で新しい UID が付く。手で整理した古いメールを
 * 「新着」として送り直さないため。振り分けで直接フォルダに入ったメールは、届いた直後なので送られる
 */
export const MAX_MESSAGE_AGE_MS = 24 * 60 * 60 * 1000;

export function isTooOld(internalDate: Date | string | undefined, now: Date): boolean {
  if (internalDate === undefined) return false;
  const arrived = new Date(internalDate).getTime();
  return Number.isFinite(arrived) && now.getTime() - arrived > MAX_MESSAGE_AGE_MS;
}

/** 見ない特別なフォルダ（RFC 6154 の印）。\\All と \\Flagged はほかのフォルダの重なりなので外す */
const SKIPPED_SPECIAL_USE = new Set(['\\Sent', '\\Drafts', '\\Trash', '\\Junk', '\\All', '\\Flagged']);
/** 印が付いていないときに名前で見分ける。Yahoo! JAPAN の名前と、よくある名前 */
const SKIPPED_NAMES = new Set(
  [
    'sent', 'sent items', 'sent messages', 'sent mail', 'draft', 'drafts', 'trash', 'deleted items', 'deleted messages',
    'bulk mail', 'bulk', 'spam', 'junk', 'junk e-mail', 'junk mail',
    '送信済み', '送信済みメール', '送信済みアイテム', '下書き', 'ゴミ箱', '削除済み', '削除済みアイテム', '迷惑メール',
  ].map((name) => name.toLowerCase()),
);

/**
 * 見るフォルダか。迷惑メール・ゴミ箱・送信済み・下書きと、選べないフォルダ（\\Noselect）を外し、残りは全部見る。
 * 個人フォルダを作り足しても、設定し直さずに見る対象に入る
 */
export function isWatchedFolder(folder: { path: string; name: string; specialUse?: string; flags?: Set<string> }): boolean {
  if (folder.flags && [...folder.flags].some((flag) => /^\\(Noselect|NonExistent)$/i.test(flag))) return false;
  if (folder.specialUse && SKIPPED_SPECIAL_USE.has(folder.specialUse)) return false;
  return !SKIPPED_NAMES.has(folder.name.toLowerCase());
}

/** 受信箱を先に、残りはパスの順に並べる（1 回の上限に届いたとき、受信箱を後回しにしない） */
export function orderFolders(paths: string[]): string[] {
  return [...paths].sort((a, b) => (a === 'INBOX' ? -1 : b === 'INBOX' ? 1 : a.localeCompare(b)));
}

/** 今回ログインを試すか。失敗が続いていたら 1 時間に 1 回まで */
export function shouldTryLogin(state: RelayState, now: Date): boolean {
  if (state.authFailures < AUTH_BACKOFF_AFTER || !state.lastAuthFailureAt) return true;
  return now.getTime() - Date.parse(state.lastAuthFailureAt) >= AUTH_BACKOFF_MS;
}

/**
 * Secrets Manager に入れる設定。`{ "user", "password", "forwardTo", "sub" }`。
 * `sub` は転送の条件を読む利用者（設定画面で直した条件が、その利用者のデータに入る）。無ければ全部を転送する
 */
export type RelayConfig = { user: string; password: string; forwardTo: string; sub?: string };

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
      return {
        user: value.user,
        password: value.password,
        forwardTo: value.forwardTo,
        ...(typeof value.sub === 'string' && value.sub !== '' ? { sub: value.sub } : {}),
      };
    }
  } catch {
    // 作ったばかりのシークレット（乱数）は JSON ではない。未設定として扱う
  }
  return undefined;
}
