import { generateKifuMarkdown, type KifuExportInput } from '../kifu-export';
import { resolveUserSide } from '../lib/self';
import { CopyButton } from './CopyButton';

export function KifuExport({ kifu }: { kifu: KifuExportInput }) {
  const { side: userSide } = resolveUserSide(kifu.sente, kifu.gote);

  // 注目局面の選定は判定と同じ閾値を使う（ページ側から渡ってくる）
  const markdown = generateKifuMarkdown({ ...kifu, userSide });

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
      <CopyButton
        text={markdown}
        label="クリップボードにコピー"
        className="btn-primary self-start"
      />
    </div>
  );
}
