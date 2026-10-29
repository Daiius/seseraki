/**
 * daisyUI の dropdown（`:focus` / `:focus-within` で開閉する。JS を持たない）を閉じる。
 *
 * 中の項目を押してもフォーカスが内側に残ったままで開きっぱなしになるので、
 * 押した要素のフォーカスを明示的に外して閉じる（棋譜詳細の ⋯ メニュー・解く画面のケバブ）。
 * ⚠ `<details>` 版の dropdown（ヘッダーのメニュー）には効かない——あちらは open 属性を外す
 */
export function closeMenu(): void {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}
