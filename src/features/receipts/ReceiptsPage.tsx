import { useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Camera, ImageIcon } from 'lucide-react';
import {
  MAX_RECEIPT_PHOTOS,
  SOURCE_LABELS,
  activeCategories,
  applyReceipt,
  autoMatch,
  findCandidates,
  findDuplicateReceipts,
  formatYen,
  hasImportableStatement,
  latestUsdRate,
  learnItemRules,
  linkedTransaction,
  markNotDuplicate,
  mergeItemRules,
  transactionFromReceipt,
  transactionToRemoveWith,
  type DuplicateReceiptPair,
  type MatchCandidate,
  type Receipt,
  type SourceKind,
  type Transaction,
} from '@kakeibo/core';
import { useStore } from '../../api/store';
import { Notice } from '../../components/ui/Notice';
import { Button, Card } from '../../components/ui/primitives';
import { config } from '../../config';
import { useAction } from '../../lib/action';
import { errorMessage } from '../../lib/errors';
import { useNotice } from '../../lib/notice';
import { DraftEditor } from './DraftEditor';
import { DuplicateReceiptsCard } from './DuplicateReceiptsCard';
import { MatchCandidates } from './MatchCandidates';
import { ReadingProgress, type Reading, type ReadingStage } from './ReadingProgress';
import { PaymentMethodField } from './ReceiptParts';
import { SavedReceiptList } from './SavedReceiptList';
import {
  READABLE_IMAGE_TYPES,
  draftFromReceipt,
  editedReceipt,
  emptyDraft,
  imageFields,
  lacksDate,
  lacksRate,
  paymentPhrase,
  receiptFromDraft,
  type Draft,
  type DraftItem,
} from './draft';
import { ReadPhotosError, readPhotos } from './readPhotos';
import { shrinkPhoto } from './shrinkPhoto';

/**
 * レシートを読み込んで明細に当てる画面。この家計簿の主役。
 * 写真 → OCR → 品目ごとのカテゴリ → 金額と日付で明細に自動マッチ、までを 1 画面で済ませる。
 *
 * ここに置くのは画面の状態と保存の流れだけ。下書きの扱いは draft.ts、写真を読む流れは readPhotos.ts、
 * 欄や一覧は DraftEditor などの部品にある。
 */
export function ReceiptsPage() {
  const { snapshot, saveReceipt, removeReceipt, saveTransaction, saveTransactions, removeTransaction, saveRules } = useStore();
  const cameraRef = useRef<HTMLInputElement>(null);
  // 撮るのとは別の入力にする。capture を付けるとスマホはカメラしか開かず、撮り溜めた写真を選べない
  const libraryRef = useRef<HTMLInputElement>(null);

  const [draft, setDraft] = useState<Draft | undefined>();
  /**
   * 保存済みのレシートを開いて直しているときの、開いた時点のレシート。
   * 明細とつながったもの（matched / cash）は、つながりはそのままに中身だけ直す。
   * 未紐付けのものは読み取り直後と同じ流れで、明細に当てるか登録するかを選び直せる
   */
  const [editing, setEditing] = useState<Receipt | undefined>();
  const [selectedTxnId, setSelectedTxnId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  /** 写真を選んでから下書きが出るまでの進み具合。読み取り中でなければ undefined */
  const [reading, setReading] = useState<Reading | undefined>();
  const { notice, info, fail, clear } = useNotice();
  const run = useAction();

  const categories = activeCategories(snapshot.categories);
  const linked = editing && editing.status !== 'pending' ? linkedTransaction(editing, snapshot.transactions) : undefined;

  /**
   * 同じレシートを 2 回撮ったもの。ID は撮った時刻から作るので中身が同じでも別 ID になり、
   * 保存済み一覧では未紐付けが 2 枚並ぶだけで気づけない。ここで名指しする。
   */
  const duplicates = useMemo(() => findDuplicateReceipts(snapshot.receipts), [snapshot.receipts]);

  const candidates = useMemo<MatchCandidate[]>(() => {
    if (!draft || draft.total <= 0) return [];
    const receipt: Receipt = { ...draft, items: draft.items, status: 'pending' };
    return findCandidates(receipt, snapshot.transactions);
  }, [draft, snapshot.transactions]);

  /**
   * 同じレシートだと言われた組。残す方を選んでもらい、もう片方を消す。
   * 消す方から作った明細（支払い方法を選んで登録したもの）も一緒に消さないと、支払いが二重に残る。
   * 取り込んだ明細に当てただけのレシートなら、明細は本物なのでそのまま残す
   */
  async function keepOneReceipt(keep: Receipt, drop: Receipt) {
    const created = transactionToRemoveWith(drop, snapshot.transactions);
    const notice = created ? '。このレシートから作った明細も一緒に消えます' : '';
    if (!window.confirm(`${drop.date} の ${drop.storeName || '店名なし'} を消して、もう片方を残しますか${notice}`)) return;
    await deleteReceipt(drop, created);
    info(`同じレシートとして片方を消しました。${keep.storeName || '店名なし'} のレシートが残っています。`);
  }

  /** 保存済み一覧のゴミ箱。重複の組を片付けるときと同じく、レシートから作った明細も一緒に消す */
  async function confirmDeleteReceipt(receipt: Receipt) {
    const created = transactionToRemoveWith(receipt, snapshot.transactions);
    const notice = created ? '。このレシートから作った明細も一緒に消えます' : '';
    if (!window.confirm(`このレシートを消しますか${notice}`)) return;
    await deleteReceipt(receipt, created);
  }

  async function deleteReceipt(receipt: Receipt, created: Transaction | undefined) {
    await removeReceipt(receipt.id);
    if (created) await removeTransaction(created.id);
  }

  /** 別の買い物だと言われた組。両側に印を付けて、次からは候補に出さない */
  async function dismissDuplicateReceipts(pair: DuplicateReceiptPair) {
    const [a, b] = markNotDuplicate(pair.a, pair.b);
    await saveReceipt(a);
    await saveReceipt(b);
  }

  /** 写真を読んで下書きにする。読む流れそのものは readPhotos */
  async function onImages(files: File[]) {
    clear();
    if (files.length > MAX_RECEIPT_PHOTOS) {
      info(`1 枚のレシートとして読めるのは ${MAX_RECEIPT_PHOTOS} 枚までです。選び直してください。`);
      return;
    }
    setBusy(true);
    // 送る前にモデルが読める大きさまで縮め、JPEG に直す（shrinkPhoto）。縮められなかった写真は元のまま
    const photos = await Promise.all(files.map((file) => shrinkPhoto(file)));
    if (photos.some((photo) => photo.type && !READABLE_IMAGE_TYPES.includes(photo.type))) {
      info('この形式の画像は読めません。JPEG・PNG・WebP の写真を選んでください。');
      setBusy(false);
      return;
    }
    const previewUrls = files.map((file) => URL.createObjectURL(file));
    try {
      const next = await readPhotos(
        photos,
        { categories: snapshot.categories, rules: snapshot.rules, receipts: snapshot.receipts },
        {
          onStage: (stage: ReadingStage) => setReading({ stage, uploaded: 0, stageStartedAt: Date.now(), previewUrls }),
          onUploaded: (uploaded) => setReading((now) => (now?.stage === 'upload' ? { ...now, uploaded } : now)),
        },
      );
      setEditing(undefined);
      setDraft(next);
      const auto = autoMatch(findCandidates({ ...next, status: 'pending' }, snapshot.transactions));
      setSelectedTxnId(auto?.id);
      if (auto) info(`${auto.rawMerchant} の明細に自動で当てました。違っていれば下で選び直してください。`);
    } catch (cause) {
      const keys = cause instanceof ReadPhotosError ? cause.keys : [];
      const reason = errorMessage(cause instanceof ReadPhotosError ? cause.reason : cause);
      fail(
        keys.length === files.length
          ? `写真は届いていますが、読み取れませんでした。下に手で入れてください。（${reason}）`
          : keys.length > 0
            ? `${files.length} 枚のうち ${keys.length} 枚しか送れませんでした。届いた写真だけ付けておくので、下に手で入れてください。（${reason}）`
            : reason,
      );
      setEditing(undefined);
      setDraft({ ...emptyDraft(), ...imageFields(keys) });
    } finally {
      setReading(undefined);
      previewUrls.forEach((url) => URL.revokeObjectURL(url));
      setBusy(false);
    }
  }

  /** asPayment: レシートから明細を作って登録する（支払い方法は draft.paidWith） */
  async function save(asPayment: boolean) {
    if (!draft) return;
    setBusy(true);
    try {
      const selected = selectedTxnId && !asPayment ? snapshot.transactions.find((item) => item.id === selectedTxnId) : undefined;
      const receipt = receiptFromDraft(draft, {
        asPayment,
        txnId: selectedTxnId,
        paidYen: selected?.amount,
        createdAt: editing?.createdAt ?? new Date().toISOString(),
      });
      await saveReceipt(receipt);
      const learned = await learnFromDraft(draft.items);

      if (asPayment) {
        // 新しい明細なので saveTransactions で足す。saveTransaction は既にある明細の差し替えにしか効かない
        await saveTransactions([transactionFromReceipt(receipt, draft.paidWith)]);
        info(`${paymentPhrase(draft.paidWith)}として明細に足しました。${learned}`);
      } else if (selectedTxnId) {
        if (selected) {
          await saveTransaction(applyReceipt(selected, receipt));
          info(`明細に当てました。内訳が品目ごとに分かれています。${learned}`);
        }
      } else {
        info(`レシートだけ保存しました。対応する明細を取り込んだら、もう一度開いて当ててください。${learned}`);
      }

      closeDraft();
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  }

  /**
   * 人がカテゴリを選び直した品目を覚える。次に同じ名前の品目を読んだら、判定に聞かずにこのカテゴリにする。
   * 返すのは保存後の知らせに足す一文（覚えたものが無ければ空）。
   */
  async function learnFromDraft(items: DraftItem[]): Promise<string> {
    const learned = learnItemRules(items);
    if (learned.length === 0) return '';
    await saveRules(mergeItemRules(snapshot.rules, learned));
    return `直したカテゴリを ${learned.length} 品目ぶん覚えました。次から同じ品目に当てます。`;
  }

  function openReceipt(receipt: Receipt) {
    setDraft(draftFromReceipt(receipt));
    setEditing(receipt);
    setSelectedTxnId(receipt.txnId);
    clear();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function closeDraft() {
    setDraft(undefined);
    setEditing(undefined);
    setSelectedTxnId(undefined);
  }

  /**
   * 明細とつながった保存済みのレシートを直す。つながりは変えずに、レシートと明細の両方を差し替える。
   * レシートから作った明細は日付・金額・店名・支払い方法・内訳を、紐付けた明細は内訳だけを直す
   * （紐付けた明細の金額は取り込んだ請求額なので、レシートの側から書き換えない）。
   */
  async function saveEdit() {
    if (!draft || !editing) return;
    setBusy(true);
    try {
      const receipt = editedReceipt(editing, draft, editing.status === 'matched' ? linked?.amount : undefined);
      await saveReceipt(receipt);
      const learned = await learnFromDraft(draft.items);

      if (editing.status === 'cash') {
        const txn = transactionFromReceipt(receipt, draft.paidWith, linked);
        await (linked ? saveTransaction(txn) : saveTransactions([txn]));
        info(`${linked ? 'レシートと明細を直しました。' : 'レシートを直し、消えていた明細を作り直しました。'}${learned}`);
      } else if (linked) {
        await saveTransaction(applyReceipt(linked, receipt));
        info(`レシートを直し、紐付けた明細の内訳も合わせました。${learned}`);
      } else {
        info(`レシートを直しました。紐付けていた明細は見つかりませんでした。${learned}`);
      }
      closeDraft();
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  }

  function onPicked(event: ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])];
    if (files.length > 0) void onImages(files);
    // 同じ写真を選び直しても onChange が来るように空にしておく
    event.target.value = '';
  }

  function setPaidWith(paidWith: SourceKind) {
    if (draft) setDraft({ ...draft, paidWith });
  }

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-ink">レシート</h1>

      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" onClick={() => cameraRef.current?.click()} disabled={busy || config.mode === 'local'}>
            <Camera size={15} />
            写真を読む
          </Button>
          <Button onClick={() => libraryRef.current?.click()} disabled={busy || config.mode === 'local'}>
            <ImageIcon size={15} />
            カメラロールから
          </Button>
          <Button
            onClick={() => {
              closeDraft();
              setDraft(emptyDraft());
            }}
            disabled={busy}
          >
            手で入れる
          </Button>
          <input
            ref={cameraRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={onPicked}
          />
          <input
            ref={libraryRef}
            type="file"
            accept={READABLE_IMAGE_TYPES.join(',')}
            multiple
            className="hidden"
            onChange={onPicked}
          />
        </div>
        <p className="mt-2 text-xs text-muted">
          {config.mode === 'local'
            ? 'ローカルモードでは OCR が使えません。品目を手で入れるか、AWS 側をデプロイしてください。'
            : `写真を撮るか、カメラロールから選ぶと Claude が品目と金額を読み、金額と日付の近い明細に自動で当てます。1 枚に収まらない長いレシートは、分けて撮った写真をカメラロールから ${MAX_RECEIPT_PHOTOS} 枚までまとめて選ぶと 1 枚として読みます。`}
        </p>
        {reading && <ReadingProgress reading={reading} />}
        {notice && (
          <Notice tone={notice.tone} className="mt-3">
            {notice.text}
          </Notice>
        )}
      </Card>

      {draft && (
        <Card title={editing ? 'レシートを直す' : '読み取り結果'} action={<Button size="sm" onClick={closeDraft}>やめる</Button>}>
          <DraftEditor draft={draft} onChange={setDraft} categories={categories} fallbackRate={latestUsdRate(snapshot.receipts)} />

          {editing && editing.status !== 'pending' ? (
            <>
              <h3 className="mt-4 text-xs font-semibold text-ink-2">
                {editing.status === 'cash' ? 'このレシートから作った明細' : '紐付けた明細'}
              </h3>
              {linked ? (
                <p className="mt-1 flex items-center gap-2 rounded-lg bg-plane px-2 py-1.5">
                  <span className="tnum text-xs text-muted">{linked.date.slice(5)}</span>
                  <span className="min-w-0 flex-1 truncate text-sm text-ink">{linked.rawMerchant || '（店名なし）'}</span>
                  <span className="text-xs text-muted">{linked.sourceLabel}</span>
                  <span className="tnum text-sm text-ink">{formatYen(linked.amount)}</span>
                </p>
              ) : (
                <p className="mt-1 text-sm text-ink-2">
                  {editing.status === 'cash'
                    ? '明細が見つかりません。保存すると作り直します。'
                    : '紐付けていた明細が見つかりません。レシートだけ直します。'}
                </p>
              )}
              {editing.status === 'matched' && (
                <p className="mt-1 text-xs text-muted">明細の金額は取り込んだ請求額のままで、品目の内訳だけを合わせ直します。</p>
              )}

              {editing.status === 'cash' && (
                <div className="mt-4 border-t border-grid pt-3">
                  <PaymentMethodField
                    value={draft.paidWith}
                    onChange={setPaidWith}
                    importableHint={
                      hasImportableStatement(draft.paidWith)
                        ? `${SOURCE_LABELS[draft.paidWith]}の利用明細も取り込むと、同じ支払いが 2 件になります。取り込んだら、明細の画面で重複として片方を消してください。`
                        : undefined
                    }
                  />
                </div>
              )}

              <div className="mt-3 flex flex-wrap justify-end gap-2">
                <Button
                  variant="primary"
                  onClick={() => void saveEdit()}
                  disabled={busy || draft.total <= 0 || lacksDate(draft) || (editing.status === 'cash' && lacksRate(draft))}
                >
                  直した内容で保存
                </Button>
              </div>
            </>
          ) : (
            <>
              <MatchCandidates draft={draft} candidates={candidates} selectedTxnId={selectedTxnId} onSelect={setSelectedTxnId} />

              <div className="mt-4 border-t border-grid pt-3">
                <PaymentMethodField
                  value={draft.paidWith}
                  onChange={setPaidWith}
                  importableHint={
                    hasImportableStatement(draft.paidWith)
                      ? `${SOURCE_LABELS[draft.paidWith]}の利用明細を取り込むなら、ここでは登録せず「レシートだけ保存」して、取り込んだ明細に当ててください。両方だと二重に数えます。`
                      : undefined
                  }
                />
              </div>

              <div className="mt-3 flex flex-wrap justify-end gap-2">
                <Button onClick={() => void save(true)} disabled={busy || draft.total <= 0 || lacksDate(draft) || lacksRate(draft)}>
                  {paymentPhrase(draft.paidWith)}として登録
                </Button>
                <Button variant="primary" onClick={() => void save(false)} disabled={busy || draft.total <= 0 || lacksDate(draft)}>
                  {selectedTxnId ? '明細に当てる' : 'レシートだけ保存'}
                </Button>
              </div>
            </>
          )}
        </Card>
      )}

      {duplicates.length > 0 && (
        <DuplicateReceiptsCard
          pairs={duplicates}
          onKeep={(keep, drop) => run(() => keepOneReceipt(keep, drop))}
          onDismiss={(pair) => run(() => dismissDuplicateReceipts(pair))}
        />
      )}

      <SavedReceiptList
        receipts={snapshot.receipts}
        categories={snapshot.categories}
        onOpen={openReceipt}
        onDelete={(receipt) => void run(() => confirmDeleteReceipt(receipt))}
      />
    </div>
  );
}
