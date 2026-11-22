import { useEffect, useState } from 'react';
import { EMPTY_MAIL_RELAY_FILTER, isFilterEmpty, parseFilterLines, type MailRelayFilter } from '@kakeibo/core';
import { useStore } from '../../api/store';
import { Button, Field } from '../../components/ui/primitives';
import { useAction } from '../../lib/action';
import { cn } from '../../lib/cn';

const TEXTAREA =
  'block w-full rounded-lg bg-plane px-2.5 py-1.5 text-base text-ink ring-1 ring-black/10 placeholder:text-muted sm:text-sm dark:ring-white/10';

const toText = (entries: string[]) => entries.join('\n');

/**
 * Yahoo!メールの中継が Muse へ転送するメールの条件（設定の節の中身）。
 * 差出人か件名のどちらかに当たったメールだけを転送し、両方空なら全部を転送する（規則は core の mail-filter.ts）。
 * 中継の Lambda は回ごとに読み直すので、保存した条件は 5 分以内に効く。
 *
 * 1 行に 1 つ書く。保存するときに core の parseFilterLines でそろえ（空行・重なり・先頭の @ を落とす）、
 * そろえた結果を欄に戻す。何が保存されたかが、そのまま欄に見える。
 */
export function MailRelayFilterSettings() {
  const { snapshot, saveMailRelayFilter } = useStore();
  const run = useAction();
  const saved = snapshot.mailRelayFilter ?? EMPTY_MAIL_RELAY_FILTER;
  const [senders, setSenders] = useState(toText(saved.senders));
  const [subjectWords, setSubjectWords] = useState(toText(saved.subjectWords));

  // 読み込みが後から終わったとき（初回表示）に、保存済みの条件を欄に入れる
  useEffect(() => {
    setSenders(toText(saved.senders));
    setSubjectWords(toText(saved.subjectWords));
  }, [saved.senders, saved.subjectWords]);

  const next: MailRelayFilter = {
    senders: parseFilterLines(senders, 'sender'),
    subjectWords: parseFilterLines(subjectWords, 'subject'),
  };
  const changed = toText(next.senders) !== toText(saved.senders) || toText(next.subjectWords) !== toText(saved.subjectWords);

  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-2">
        差出人か件名のどちらかに当たったメールだけを Muse へ転送します。両方とも空なら、届いたメールを全部転送します。
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="差出人" hint="1 行に 1 つ。ドメイン（amazon.co.jp）かアドレス（order@shop.example）">
          <textarea
            value={senders}
            onChange={(event) => setSenders(event.target.value)}
            rows={6}
            spellCheck={false}
            autoCapitalize="none"
            // アドレスとドメインは英数字だけなので、桁の見分けやすい等幅にする
            className={cn(TEXTAREA, 'font-mono')}
          />
        </Field>
        <Field label="件名に含む言葉" hint="1 行に 1 つ。例: 注文、領収">
          <textarea value={subjectWords} onChange={(event) => setSubjectWords(event.target.value)} rows={6} className={TEXTAREA} />
        </Field>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs text-muted">
          {isFilterEmpty(saved)
            ? 'いまは全部を転送しています'
            : `いまの条件: 差出人 ${saved.senders.length} 件・件名 ${saved.subjectWords.length} 件`}
        </span>
        <Button
          variant="primary"
          disabled={!changed}
          onClick={() =>
            run(async () => {
              await saveMailRelayFilter(next);
              setSenders(toText(next.senders));
              setSubjectWords(toText(next.subjectWords));
            })
          }
        >
          保存
        </Button>
      </div>
    </div>
  );
}
