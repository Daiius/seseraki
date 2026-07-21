import { useState, type ReactNode } from 'react';

/**
 * 開かれるまで中身をマウントしない折り畳み（daisyUI collapse）。
 *
 * `<details>` は閉じていても中身がレンダーされるため、局面数ぶんの表や
 * エクスポート用テキスト生成のような重い中身を、閉じたまま毎回描画してしまう。
 * 一度開いた後はマウントしたままにする（開閉の往復を軽くし、入力中の下書きも失わない）。
 */
export function LazyDetails({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  const [opened, setOpened] = useState(false);

  return (
    <details
      className="collapse collapse-arrow bg-base-200"
      onToggle={(e) => {
        if (e.currentTarget.open) setOpened(true);
      }}
    >
      <summary className="collapse-title text-lg font-semibold">{title}</summary>
      <div className="collapse-content">{opened && children}</div>
    </details>
  );
}
