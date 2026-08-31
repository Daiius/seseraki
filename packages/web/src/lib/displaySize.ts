/**
 * 表示サイズの設定（盤の大きさ / 操作ボタンの高さ）の永続化。
 *
 * モバイルで盤を横幅いっぱいまで大きくすると、**縦のスペースが足りず評価値・読み筋が
 * 見づらくなる**（実使用で出た不満）。かといって小さい盤が常に正解でもないので、
 * **見た目の好みとして切り替えられるようにする**。
 *
 * しきい値（`lib/thresholds.ts`）や詰み手数（`lib/mateMax.ts`）と同じく、棋譜ごとではなく
 * 恒常的な好みなので **localStorage** に持つ（URL にも server にも置かない）。
 *
 * 🔒 **既定は「現状の見た目」**（`full` / `normal`）。設定を触らなければ今までと同じに見える。
 *
 * ## 盤は CSS 変数、ボタンは daisyUI のクラスで切り替える
 *
 * - **盤**: 寸法は `app.css` の `--sq` に集約されていて、盤・持ち駒・ラベル・駒文字が
 *   すべてそこから算出される。React state を各所へ配るのではなく
 *   **`document.documentElement` の `data-board-size` 属性**を立て、CSS 側
 *   （`:root[data-board-size='compact']`）で `--sq-scale` を差し替える。1 箇所で全部に効く。
 * - **ボタン**: 高さは daisyUI の `btn-sm` が持っている。CSS で真似ると
 *   **daisyUI の内部変数（`--size` / `--btn-p` / `--fontsize`）を複製する**ことになり、
 *   バージョンが上がると静かにずれる。こちらは公開 API であるクラスの付け外しで済ませる。
 */

import { useState } from 'react';

/** `full` = 従来どおり幅いっぱいまで / `compact` = 少し小さくして縦を空ける */
export type BoardSize = 'full' | 'compact';
/** `normal` = 従来どおり（モバイルは daisyUI 既定サイズ） / `compact` = モバイルでも `btn-sm` */
export type ControlSize = 'normal' | 'compact';

export type DisplaySize = {
  boardSize: BoardSize;
  controlSize: ControlSize;
};

/** 既定は現状維持（設定を触らなければ見た目が変わらない） */
export const DEFAULT_DISPLAY_SIZE: DisplaySize = {
  boardSize: 'full',
  controlSize: 'normal',
};

const STORAGE_KEY = 'seseraki:displaySize';

const BOARD_SIZES: readonly BoardSize[] = ['full', 'compact'];
const CONTROL_SIZES: readonly ControlSize[] = ['normal', 'compact'];

/**
 * localStorage の生の文字列を設定に変換する。
 * 手で書き換えられていても壊れないよう、**値ごとに**既定へフォールバックする
 * （`lib/thresholds.ts` と同じ流儀。片方だけ壊れていてももう片方は生かす）。
 */
export function parseDisplaySize(raw: string | null): DisplaySize {
  if (!raw) return DEFAULT_DISPLAY_SIZE;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_DISPLAY_SIZE;
  }
  if (typeof parsed !== 'object' || parsed === null) return DEFAULT_DISPLAY_SIZE;
  const v = parsed as Partial<Record<keyof DisplaySize, unknown>>;
  return {
    boardSize: BOARD_SIZES.includes(v.boardSize as BoardSize)
      ? (v.boardSize as BoardSize)
      : DEFAULT_DISPLAY_SIZE.boardSize,
    controlSize: CONTROL_SIZES.includes(v.controlSize as ControlSize)
      ? (v.controlSize as ControlSize)
      : DEFAULT_DISPLAY_SIZE.controlSize,
  };
}

function loadDisplaySize(): DisplaySize {
  try {
    return parseDisplaySize(localStorage.getItem(STORAGE_KEY));
  } catch {
    // localStorage が使えない環境（プライベートモード等）でも既定値で動かす
    return DEFAULT_DISPLAY_SIZE;
  }
}

function saveDisplaySize(value: DisplaySize): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // 保存できなくてもセッション中の変更は効かせる
  }
}

/**
 * 盤の寸法を CSS へ反映する（`app.css` の `:root[data-board-size='compact']`）。
 * 既定側は属性を**外す**（`:root` の素の値に戻す）ので、既定の見た目が属性の有無に依存しない。
 */
function applyBoardSize(boardSize: BoardSize): void {
  const root = document.documentElement;
  if (boardSize === 'compact') root.setAttribute('data-board-size', 'compact');
  else root.removeAttribute('data-board-size');
}

/**
 * アプリ起動時に 1 回呼ぶ（`main.tsx`）。**設定ページを開かなくても効かせる**ためと、
 * ⚠ **反映が React の描画より遅れると盤が一瞬大きく描かれてから縮む**（チラつく）ため、
 * `createRoot(...).render()` より前に済ませる。
 */
export function initDisplaySize(): void {
  applyBoardSize(loadDisplaySize().boardSize);
}

export function useDisplaySize() {
  const [displaySize, setState] = useState<DisplaySize>(loadDisplaySize);
  const setDisplaySize = (next: DisplaySize) => {
    setState(next);
    saveDisplaySize(next);
    applyBoardSize(next.boardSize);
  };
  return { displaySize, setDisplaySize };
}
