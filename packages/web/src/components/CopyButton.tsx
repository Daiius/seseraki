import { useState } from 'react';
import clsx from 'clsx';
import { ClipboardDocumentIcon, CheckIcon } from './icons';

/**
 * テキストをクリップボードにコピーするボタン。アイコン主体で、**モバイルはアイコンのみ**
 * （フットプリントを小さく）、`sm` 以上でラベルを併記する。コピー後は 2 秒だけチェックに変わる。
 *
 * 意味は常に `aria-label` に持たせる（モバイルで文字が消えても読み上げできる）。失敗時は
 * `alert` で知らせる（KifuExport の従来挙動を踏襲）。
 */
export function CopyButton({
  text,
  label = 'コピー',
  className,
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      alert(`コピーに失敗しました: ${e}`);
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={clsx('btn btn-sm gap-1', className)}
      aria-label={copied ? 'コピーしました' : label}
    >
      {copied ? <CheckIcon className="size-4" /> : <ClipboardDocumentIcon className="size-4" />}
      <span className="hidden sm:inline">{copied ? 'コピーしました' : label}</span>
    </button>
  );
}
