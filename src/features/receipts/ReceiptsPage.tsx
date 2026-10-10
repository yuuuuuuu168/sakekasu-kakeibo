import { useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Camera, Copy, ImageIcon, Plus, Trash2 } from 'lucide-react';
import {
  CURRENCIES,
  MAX_RECEIPT_PHOTOS,
  CURRENCY_LABELS,
  RECEIPT_PAYMENT_METHODS,
  SOURCE_LABELS,
  UNCATEGORIZED_ID,
  activeCategories,
  applyReceipt,
  autoMatch,
  classifyItem,
  convertDisplayed,
  duplicateKey,
  findCandidates,
  findDuplicateReceipts,
  formatMoney,
  formatYen,
  fromMinor,
  hasImportableStatement,
  impliedRate,
  latestUsdRate,
  learnItemRules,
  linkedTransaction,
  receiptCategorySummary,
  receiptCurrency,
  receiptYenTotal,
  toMinor,
  transactionFromReceipt,
  usableRate,
  type Currency,
  type MatchCandidate,
  type Receipt,
  type ReceiptItem,
  type SourceKind,
} from '@kakeibo/core';
import { CategoryOptions } from '../../components/CategoryOptions';
import { api } from '../../api/index';
import { judgeReceiptItems } from '../../api/classify';
import { uploadToS3 } from '../../api/remote';
import { useStore } from '../../api/store';
import { Badge, Button, Card, EmptyState, Field, Input, Select } from '../../components/ui/primitives';
import { config } from '../../config';
import { todayIso } from '../../lib/month';
import { ReadingProgress, type Reading, type ReadingStage } from './ReadingProgress';

type Draft = {
  id: string;
  storeName: string;
  date: string;
  /** 合計と品目の金額は currency の最小単位（円、セント） */
  total: number;
  items: DraftItem[];
  currency: Currency;
  /** ドルのときの 1 ドルの円。円のときは使わない */
  exchangeRate?: number;
  imageKey?: string;
  /** 分けて撮ったときの全部の写真。1 枚なら持たない */
  imageKeys?: string[];
  /** 明細を作って登録するときの支払い方法。OCR が支払いの印字から読めたらそれ、無ければ現金 */
  paidWith: SourceKind;
  warnings?: string[];
};

/**
 * 下書きの品目。categoryEdited は人がカテゴリを選び直した印で、保存するときに
 * その品目名とカテゴリを覚える（learnItemRules）。レシートには残さない。
 */
type DraftItem = ReceiptItem & { categoryEdited?: boolean };

/** 下書きの品目から、保存する品目を作る。覚えるための印を落とす */
function toReceiptItems(items: DraftItem[]): ReceiptItem[] {
  return items.map(({ categoryEdited: _edited, ...item }) => item);
}

/** 保存済みのレシートを直すときの下書き。読み取り結果と同じ欄に載せる */
function draftFromReceipt(receipt: Receipt): Draft {
  return {
    id: receipt.id,
    storeName: receipt.storeName,
    date: receipt.date,
    total: receipt.total,
    items: receipt.items,
    currency: receiptCurrency(receipt),
    ...(receipt.exchangeRate !== undefined ? { exchangeRate: receipt.exchangeRate } : {}),
    ...(receipt.imageKey ? { imageKey: receipt.imageKey } : {}),
    ...(receipt.imageKeys ? { imageKeys: receipt.imageKeys } : {}),
    paidWith: receipt.paidWith ?? 'cash',
  };
}

/**
 * 下書きから、レシートに保存する通貨の欄を作る。円なら何も持たせない（これまでのレシートと同じ形）。
 * `paidYen` は当てた明細の請求額。渡すと、そこから割り戻した実際のレートを残す。
 */
function currencyFields(draft: Draft, paidYen?: number): Pick<Receipt, 'currency' | 'exchangeRate'> {
  if (draft.currency === 'JPY') return {};
  const rate = (paidYen !== undefined ? impliedRate(paidYen, draft.total) : undefined) ?? usableRate(draft.exchangeRate);
  return { currency: draft.currency, ...(rate !== undefined ? { exchangeRate: rate } : {}) };
}

/** 円に直せない下書き（ドルなのにレートが無い）。明細を作れない */
function lacksRate(draft: Draft): boolean {
  return draft.currency !== 'JPY' && usableRate(draft.exchangeRate) === undefined;
}

/** 登録ボタンの文言と、登録後の知らせに使う。「不明払い」とは言わないので分けている */
function paymentPhrase(method: SourceKind): string {
  return method === 'unknown' ? '支払い方法不明' : `${SOURCE_LABELS[method]}払い`;
}

/**
 * OCR が読める形式。読む側（ocr-receipt）が中身のバイト列で確かめるのもこの 3 つ。
 * カメラロールから選ぶ入力にはこれを列挙して渡す。iOS は HEIC の写真をここに無い形式と見て
 * JPEG に直してから渡してくれる。`image/*` だと HEIC のまま届いて OCR で落ちることがある。
 */
const READABLE_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * 写真のキーを下書きの欄にする。1 枚目は imageKey、分けて撮ったときだけ imageKeys に全部を持たせる
 * （1 枚で撮ったレシートの形はこれまでと変えない）
 */
function imageFields(keys: string[]): Pick<Draft, 'imageKey' | 'imageKeys'> {
  if (keys.length === 0) return {};
  return { imageKey: keys[0], ...(keys.length > 1 ? { imageKeys: keys } : {}) };
}

function emptyDraft(): Draft {
  return { id: `r-${Date.now().toString(36)}`, storeName: '', date: todayIso(), total: 0, items: [], currency: 'JPY', paidWith: 'cash' };
}

/**
 * レシートを読み込んで明細に当てる画面。この家計簿の主役。
 * 写真 → OCR → 品目ごとのカテゴリ → 金額と日付で明細に自動マッチ、までを 1 画面で済ませる。
 */
export function ReceiptsPage() {
  const { snapshot, saveReceipt, removeReceipt, saveTransaction, saveTransactions, saveRules } = useStore();
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
  const [message, setMessage] = useState<string | undefined>();

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
   * 写真を読んで下書きにする。複数枚は、1 枚に収まらない長いレシートを分けて撮ったもの。
   * まとめて 1 回の OCR に渡し、1 枚のレシートとして読ませる
   */
  async function onImages(files: File[]) {
    setMessage(undefined);
    if (files.length > MAX_RECEIPT_PHOTOS) {
      setMessage(`1 枚のレシートとして読めるのは ${MAX_RECEIPT_PHOTOS} 枚までです。選び直してください。`);
      return;
    }
    if (files.some((file) => file.type && !READABLE_IMAGE_TYPES.includes(file.type))) {
      setMessage('この形式の画像は読めません。JPEG・PNG・WebP の写真を選んでください。');
      return;
    }
    setBusy(true);
    const previewUrls = files.map((file) => URL.createObjectURL(file));
    const enter = (stage: ReadingStage) => setReading({ stage, uploaded: 0, stageStartedAt: Date.now(), previewUrls });
    enter('upload');
    // 送った割合は全部の写真のバイト数で均す。1 枚目だけ 100% になって止まって見えないように
    const sent = files.map(() => 0);
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    const progress = () =>
      totalBytes > 0
        ? files.reduce((sum, file, index) => sum + file.size * sent[index], 0) / totalBytes
        : sent.reduce((sum, ratio) => sum + ratio, 0) / files.length;
    // 送り終えたあとに読み取りで落ちても、写真はレシートに付けて残す
    let uploadedKeys: string[] = [];
    try {
      const keys = await Promise.all(
        files.map(async (file, index) => {
          const target = await api.requestUpload(file.type || 'image/jpeg');
          await uploadToS3(target, file, (ratio) => {
            sent[index] = ratio;
            setReading((now) => (now?.stage === 'upload' ? { ...now, uploaded: progress() } : now));
          });
          return target.key;
        }),
      );
      uploadedKeys = keys;
      enter('read');
      // 1 枚なら key で送る。これまでと同じ呼び方にしておく
      const result = await api.analyzeReceipt(keys.length === 1 ? { key: keys[0] } : { keys });
      enter('classify');
      // OCR は印字を起こすところまで。どの費目かは判定（Jev）に聞く。
      // 判定が届かなければキーワード表の答えがそのまま残る
      const read = result.items.map((item) => ({ ...item, categoryId: classifyItem(item.name, item.categoryId, item.amount) }));
      const judged = await judgeReceiptItems(read, result.storeName, snapshot.categories, snapshot.rules);
      const warnings = [...(result.warnings ?? []), ...judged.warnings];

      const next: Draft = {
        id: `r-${Date.now().toString(36)}`,
        storeName: result.storeName,
        date: result.date || todayIso(),
        total: result.total,
        items: judged.items,
        currency: result.currency ?? 'JPY',
        ...(result.currency === 'USD' ? { exchangeRate: latestUsdRate(snapshot.receipts) } : {}),
        ...imageFields(keys),
        paidWith: result.paymentMethod ?? 'cash',
        ...(warnings.length > 0 ? { warnings } : {}),
      };
      setEditing(undefined);
      setDraft(next);
      const auto = autoMatch(findCandidates({ ...next, status: 'pending' }, snapshot.transactions));
      setSelectedTxnId(auto?.id);
      if (auto) setMessage(`${auto.rawMerchant} の明細に自動で当てました。違っていれば下で選び直してください。`);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      setMessage(
        uploadedKeys.length > 0 ? `写真は届いていますが、読み取れませんでした。下に手で入れてください。（${reason}）` : reason,
      );
      setEditing(undefined);
      setDraft({ ...emptyDraft(), ...imageFields(uploadedKeys) });
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
      const { paidWith, currency: _currency, exchangeRate: _rate, ...rest } = draft;
      const selected = selectedTxnId && !asPayment ? snapshot.transactions.find((item) => item.id === selectedTxnId) : undefined;
      const receipt: Receipt = {
        ...rest,
        ...currencyFields(draft, selected?.amount),
        items: toReceiptItems(draft.items),
        status: asPayment ? 'cash' : selectedTxnId ? 'matched' : 'pending',
        ...(asPayment ? { paidWith } : {}),
        ...(selectedTxnId && !asPayment ? { txnId: selectedTxnId } : {}),
        createdAt: editing?.createdAt ?? new Date().toISOString(),
      };
      await saveReceipt(receipt);
      const learned = await learnFromDraft(draft.items);

      if (asPayment) {
        // 新しい明細なので saveTransactions で足す。saveTransaction は既にある明細の差し替えにしか効かない
        await saveTransactions([transactionFromReceipt(receipt, paidWith)]);
        setMessage(`${paymentPhrase(paidWith)}として明細に足しました。${learned}`);
      } else if (selectedTxnId) {
        if (selected) {
          await saveTransaction(applyReceipt(selected, receipt));
          setMessage(`明細に当てました。内訳が品目ごとに分かれています。${learned}`);
        }
      } else {
        setMessage(`レシートだけ保存しました。対応する明細を取り込んだら、もう一度開いて当ててください。${learned}`);
      }

      closeDraft();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
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
    const ids = new Set(learned.map((rule) => rule.id));
    await saveRules([...snapshot.rules.filter((rule) => !ids.has(rule.id)), ...learned]);
    return `直したカテゴリを ${learned.length} 品目ぶん覚えました。次から同じ品目に当てます。`;
  }

  function openReceipt(receipt: Receipt) {
    setDraft(draftFromReceipt(receipt));
    setEditing(receipt);
    setSelectedTxnId(receipt.txnId);
    setMessage(undefined);
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
      const { paidWith, warnings: _warnings, currency: _currency, exchangeRate: _rate, ...rest } = draft;
      // 円に戻したときにドルの欄が残らないよう、開いた時点の通貨の欄は外してから載せ直す
      const { currency: _was, exchangeRate: _wasRate, ...base } = editing;
      const receipt: Receipt = {
        ...base,
        ...rest,
        ...currencyFields(draft, editing.status === 'matched' ? linked?.amount : undefined),
        items: toReceiptItems(draft.items),
        ...(editing.status === 'cash' ? { paidWith } : {}),
      };
      await saveReceipt(receipt);
      const learned = await learnFromDraft(draft.items);

      if (editing.status === 'cash') {
        const txn = transactionFromReceipt(receipt, paidWith, linked);
        await (linked ? saveTransaction(txn) : saveTransactions([txn]));
        setMessage(`${linked ? 'レシートと明細を直しました。' : 'レシートを直し、消えていた明細を作り直しました。'}${learned}`);
      } else if (linked) {
        await saveTransaction(applyReceipt(linked, receipt));
        setMessage(`レシートを直し、紐付けた明細の内訳も合わせました。${learned}`);
      } else {
        setMessage(`レシートを直しました。紐付けていた明細は見つかりませんでした。${learned}`);
      }
      closeDraft();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
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

  const itemsTotal = draft?.items.reduce((sum, item) => sum + item.amount, 0) ?? 0;
  const money = (amount: number) => formatMoney(amount, draft?.currency ?? 'JPY');
  /** 下書きの合計を円に直した額。ドルのときだけ添える */
  const yenHint =
    draft && draft.currency !== 'JPY' && !lacksRate(draft)
      ? `約 ${formatYen(receiptYenTotal(draft))}`
      : undefined;

  /** 通貨を切り替える。画面に見えている数はそのままにする（OCR が通貨を取り違えたとき用） */
  function changeCurrency(next: Currency) {
    if (!draft || draft.currency === next) return;
    const convert = (amount: number) => convertDisplayed(amount, draft.currency, next);
    setDraft({
      ...draft,
      currency: next,
      total: convert(draft.total),
      items: draft.items.map((item) => ({ ...item, amount: convert(item.amount) })),
      ...(next === 'USD' && usableRate(draft.exchangeRate) === undefined ? { exchangeRate: latestUsdRate(snapshot.receipts) } : {}),
    });
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
            : `写真を撮るか、カメラロールから選ぶと Bedrock が品目と金額を読み、金額と日付の近い明細に自動で当てます。1 枚に収まらない長いレシートは、分けて撮った写真をカメラロールから ${MAX_RECEIPT_PHOTOS} 枚までまとめて選ぶと 1 枚として読みます。`}
        </p>
        {reading && <ReadingProgress reading={reading} />}
        {message && <p className="mt-3 rounded-lg bg-plane px-3 py-2 text-sm text-ink">{message}</p>}
      </Card>

      {draft && (
        <Card title={editing ? 'レシートを直す' : '読み取り結果'} action={<Button size="sm" onClick={closeDraft}>やめる</Button>}>
          {draft.warnings && draft.warnings.length > 0 && (
            <ul className="mb-3 space-y-1 rounded-lg bg-warning/12 px-3 py-2 text-xs text-ink">
              {draft.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}

          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="店名">
              <Input value={draft.storeName} onChange={(event) => setDraft({ ...draft, storeName: event.target.value })} />
            </Field>
            <Field label="日付">
              <Input type="date" value={draft.date} onChange={(event) => setDraft({ ...draft, date: event.target.value })} />
            </Field>
            {/* 1 つの label に 2 つの入力を入れると、ラベルを押したときに通貨の側へ行ってしまう */}
            <div className="flex gap-1.5">
              <div className="w-[4.5rem] shrink-0">
                <Field label="通貨">
                  <Select
                    value={draft.currency}
                    onChange={(event) => changeCurrency(event.target.value as Currency)}
                    className="w-full"
                  >
                    {CURRENCIES.map((currency) => (
                      <option key={currency} value={currency}>
                        {CURRENCY_LABELS[currency]}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <div className="min-w-0 flex-1">
                <Field label="合計" hint={itemsTotal !== draft.total ? `品目の合計は ${money(itemsTotal)}` : yenHint}>
                  <MoneyInput amount={draft.total} currency={draft.currency} onChange={(total) => setDraft({ ...draft, total })} className="w-full" />
                </Field>
              </div>
            </div>
          </div>

          {draft.currency !== 'JPY' && (
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <Field
                label="1 ドルの円"
                hint={
                  lacksRate(draft)
                    ? 'レートを入れてください'
                    : itemsTotal !== draft.total
                      ? yenHint
                      : '明細に当てると、請求額から実際のレートに置き換えます'
                }
              >
                <Input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  value={draft.exchangeRate ?? ''}
                  onChange={(event) => {
                    const rate = Number(event.target.value);
                    setDraft({ ...draft, exchangeRate: event.target.value === '' || !Number.isFinite(rate) ? undefined : rate });
                  }}
                  className="tnum text-right"
                />
              </Field>
            </div>
          )}

          <h3 className="mt-4 text-xs font-semibold text-ink-2">品目</h3>
          <ul className="mt-1 space-y-2">
            {draft.items.map((item, index) => (
              // 目印に品目名を混ぜると、1 文字打つたびに行が作り直されて入力欄から外れる
              <li key={index} className="flex items-center gap-1.5">
                {/* 左からカテゴリ・品名・金額。幅は品名に回し、カテゴリは選べる分だけに絞る */}
                <Select
                  value={item.categoryId ?? UNCATEGORIZED_ID}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      items: draft.items.map((row, position) =>
                        position === index ? { ...row, categoryId: event.target.value, categoryEdited: true } : row,
                      ),
                    })
                  }
                  className="w-[5.5rem] min-w-0 shrink-0"
                  aria-label="カテゴリ"
                >
                  <CategoryOptions categories={categories} />
                </Select>
                <Input
                  value={item.name}
                  onChange={(event) =>
                    setDraft({ ...draft, items: draft.items.map((row, position) => (position === index ? { ...row, name: event.target.value } : row)) })
                  }
                  placeholder="品目名"
                  className="min-w-0 flex-1"
                  aria-label="品目名"
                />
                <MoneyInput
                  amount={item.amount}
                  currency={draft.currency}
                  onChange={(amount) =>
                    setDraft({
                      ...draft,
                      items: draft.items.map((row, position) => (position === index ? { ...row, amount } : row)),
                    })
                  }
                  className="w-[4.5rem] shrink-0"
                  aria-label="金額"
                />
                <button
                  type="button"
                  onClick={() => setDraft({ ...draft, items: draft.items.filter((_, position) => position !== index) })}
                  className="shrink-0 rounded-md p-1 text-ink-2 hover:bg-plane"
                  aria-label="この品目を消す"
                >
                  <Trash2 size={15} />
                </button>
              </li>
            ))}
          </ul>
          <Button
            size="sm"
            className="mt-2"
            onClick={() => setDraft({ ...draft, items: [...draft.items, { name: '', amount: 0, categoryId: UNCATEGORIZED_ID }] })}
          >
            <Plus size={14} />
            品目を足す
          </Button>

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
                  <Field
                    label="支払い方法"
                    hint={
                      hasImportableStatement(draft.paidWith)
                        ? `${SOURCE_LABELS[draft.paidWith]}の利用明細も取り込むと、同じ支払いが 2 件になります。取り込んだら、明細の画面で重複として片方を消してください。`
                        : undefined
                    }
                  >
                    <Select
                      value={draft.paidWith}
                      onChange={(event) => setDraft({ ...draft, paidWith: event.target.value as SourceKind })}
                      className="w-full"
                    >
                      {RECEIPT_PAYMENT_METHODS.map((method) => (
                        <option key={method} value={method}>
                          {SOURCE_LABELS[method]}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
              )}

              <div className="mt-3 flex flex-wrap justify-end gap-2">
                <Button
                  variant="primary"
                  onClick={() => void saveEdit()}
                  disabled={busy || draft.total <= 0 || (editing.status === 'cash' && lacksRate(draft))}
                >
                  直した内容で保存
                </Button>
              </div>
            </>
          ) : (
            <>
              <h3 className="mt-4 text-xs font-semibold text-ink-2">当てる明細</h3>
              {candidates.length === 0 ? (
                <p className="mt-1 text-sm text-ink-2">
                  {draft.currency === 'JPY'
                    ? `金額 ${formatYen(draft.total)} に一致する明細がありません。`
                    : `${money(draft.total)}${yenHint ? `（${yenHint}）` : ''} に近い明細がありません。`}
                  支払い方法を選べば、そのまま明細として登録できます。
                </p>
              ) : (
                <ul className="mt-1 space-y-1">
                  {candidates.map((candidate) => (
                    <li key={candidate.txn.id}>
                      <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-plane">
                        <input
                          type="radio"
                          name="candidate"
                          checked={selectedTxnId === candidate.txn.id}
                          onChange={() => setSelectedTxnId(candidate.txn.id)}
                        />
                        <span className="tnum text-xs text-muted">{candidate.txn.date.slice(5)}</span>
                        <span className="min-w-0 flex-1 truncate text-sm text-ink">{candidate.txn.rawMerchant}</span>
                        <span className="text-xs text-muted">{candidate.reasons.join('・')}</span>
                        <span className="tnum text-sm text-ink">{formatYen(candidate.txn.amount)}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}

              <div className="mt-4 border-t border-grid pt-3">
                <Field
                  label="支払い方法"
                  hint={
                    hasImportableStatement(draft.paidWith)
                      ? `${SOURCE_LABELS[draft.paidWith]}の利用明細を取り込むなら、ここでは登録せず「レシートだけ保存」して、取り込んだ明細に当ててください。両方だと二重に数えます。`
                      : undefined
                  }
                >
                  <Select
                    value={draft.paidWith}
                    onChange={(event) => setDraft({ ...draft, paidWith: event.target.value as SourceKind })}
                    className="w-full"
                  >
                    {RECEIPT_PAYMENT_METHODS.map((method) => (
                      <option key={method} value={method}>
                        {SOURCE_LABELS[method]}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>

              <div className="mt-3 flex flex-wrap justify-end gap-2">
                <Button onClick={() => void save(true)} disabled={busy || draft.total <= 0 || lacksRate(draft)}>
                  {paymentPhrase(draft.paidWith)}として登録
                </Button>
                <Button variant="primary" onClick={() => void save(false)} disabled={busy || draft.total <= 0}>
                  {selectedTxnId ? '明細に当てる' : 'レシートだけ保存'}
                </Button>
              </div>
            </>
          )}
        </Card>
      )}

      {duplicates.length > 0 && (
        <Card title={`同じレシートかもしれない組 ${duplicates.length} 件`}>
          <p className="text-xs text-muted">
            合計が一致して日付が近いレシートです。2 回撮ったものなら片方を消してください。別々の買い物ならそのままで構いません
          </p>
          <ul className="mt-2 divide-y divide-grid">
            {duplicates.map((pair) => (
              <li key={duplicateKey(pair)} className="py-2">
                <div className="flex items-center gap-1.5">
                  <Copy size={14} className="text-muted" aria-hidden />
                  <span className="text-xs text-muted">{pair.reasons.join('・')}</span>
                </div>
                <ul className="mt-1.5 space-y-1">
                  {[pair.a, pair.b].map((item) => (
                    <li key={item.id} className="flex items-center gap-2 rounded-lg bg-plane px-2 py-1.5">
                      <span className="tnum text-xs text-muted">{item.date.slice(5)}</span>
                      <span className="min-w-0 flex-1 truncate text-sm text-ink">{item.storeName || '（店名なし）'}</span>
                      {item.status === 'matched' && <Badge tone="good">明細に紐付き</Badge>}
                      {item.status === 'cash' && <Badge tone="neutral">{SOURCE_LABELS[item.paidWith ?? 'cash']}</Badge>}
                      {item.status === 'pending' && <Badge tone="warning">未紐付け</Badge>}
                      <span className="tnum text-sm font-semibold text-ink">{formatMoney(item.total, receiptCurrency(item))}</span>
                      <button
                        type="button"
                        onClick={() => {
                          if (window.confirm('このレシートを消しますか')) void removeReceipt(item.id);
                        }}
                        className="rounded-md p-1.5 text-ink-2 hover:bg-surface"
                        aria-label={`${item.date} の ${item.storeName || '店名なし'} のレシートを消す`}
                      >
                        <Trash2 size={15} />
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title={`保存済み ${snapshot.receipts.length} 枚`}>
        {snapshot.receipts.length === 0 ? (
          <EmptyState title="まだレシートがありません">
            内訳待ちの明細は、レシートを読ませると品目ごとに分かれます
          </EmptyState>
        ) : (
          <ul className="divide-y divide-grid">
            {[...snapshot.receipts]
              .sort((a, b) => b.date.localeCompare(a.date))
              .map((receipt) => (
                <li key={receipt.id} className="flex items-center gap-2 py-2">
                  {/* 行を押すと上の欄に開いて、中身を見たり直したりできる */}
                  <button
                    type="button"
                    onClick={() => openReceipt(receipt)}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left hover:bg-plane"
                    aria-label={`${receipt.date} の ${receipt.storeName || '店名なし'} のレシートを開く`}
                  >
                    <span className="tnum text-xs text-muted">{receipt.date.slice(5)}</span>
                    <span className="min-w-0 flex-1 truncate text-sm text-ink">{receipt.storeName || '（店名なし）'}</span>
                    <span className="shrink-0 text-xs text-muted">{receiptCategorySummary(receipt, snapshot.categories)}</span>
                  </button>
                  {receipt.status === 'matched' && <Badge tone="good">明細に紐付き</Badge>}
                  {receipt.status === 'cash' && <Badge tone="neutral">{SOURCE_LABELS[receipt.paidWith ?? 'cash']}</Badge>}
                  {receipt.status === 'pending' && <Badge tone="warning">未紐付け</Badge>}
                  <span className="tnum text-sm font-medium text-ink">{formatMoney(receipt.total, receiptCurrency(receipt))}</span>
                  <button
                    type="button"
                    onClick={() => {
                      if (window.confirm('このレシートを消しますか')) void removeReceipt(receipt.id);
                    }}
                    className="rounded-md p-1.5 text-ink-2 hover:bg-plane"
                    aria-label="消す"
                  >
                    <Trash2 size={15} />
                  </button>
                </li>
              ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

/**
 * 金額の入力欄。保存は最小単位の整数（円、セント）で、見せるのはその通貨の数（12.34 ドル）。
 * ドルは小数を打てるように step と inputMode を変える。
 */
function MoneyInput({
  amount,
  currency,
  onChange,
  className,
  ...rest
}: {
  amount: number;
  currency: Currency;
  onChange: (amount: number) => void;
  className?: string;
  'aria-label'?: string;
}) {
  const decimal = currency !== 'JPY';
  return (
    <Input
      type="number"
      inputMode={decimal ? 'decimal' : 'numeric'}
      step={decimal ? '0.01' : '1'}
      value={fromMinor(amount, currency)}
      onChange={(event) => onChange(toMinor(Number(event.target.value) || 0, currency))}
      className={`tnum text-right ${className ?? ''}`}
      {...rest}
    />
  );
}
