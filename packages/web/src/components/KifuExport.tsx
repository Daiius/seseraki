import { useMemo, useState } from 'react';
import { generateKifuMarkdown, type KifuExportInput } from '../kifu-export';

export function KifuExport({ kifu }: { kifu: KifuExportInput }) {
  const swarsUserId = import.meta.env.VITE_SWARS_USER_ID as string | undefined;
  const userSide = swarsUserId
    ? swarsUserId === kifu.sente
      ? ('sente' as const)
      : swarsUserId === kifu.gote
        ? ('gote' as const)
        : null
    : null;

  const markdown = useMemo(
    () => generateKifuMarkdown({ ...kifu, userSide }),
    [kifu, userSide],
  );
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      alert(`コピーに失敗しました: ${e}`);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-base-content/70">
        Claude / ChatGPT 等にそのまま貼り付けて解説を依頼できます。
      </p>
      <textarea
        readOnly
        value={markdown}
        className="textarea textarea-bordered font-mono text-xs h-96 w-full"
      />
      <button onClick={handleCopy} className="btn btn-primary btn-sm self-start">
        {copied ? 'コピーしました' : 'クリップボードにコピー'}
      </button>
    </div>
  );
}
