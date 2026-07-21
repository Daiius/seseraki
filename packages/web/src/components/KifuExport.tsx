import { useState } from 'react';
import { generateKifuMarkdown, type KifuExportInput } from '../kifu-export';
import { resolveUserSide } from '../lib/self';

export function KifuExport({ kifu }: { kifu: KifuExportInput }) {
  const { side: userSide } = resolveUserSide(kifu.sente, kifu.gote);

  // 注目局面の選定は判定と同じ閾値を使う（ページ側から渡ってくる）
  const markdown = generateKifuMarkdown({ ...kifu, userSide });
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
