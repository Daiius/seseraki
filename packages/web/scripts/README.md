# packages/web/scripts

Web パッケージ用の使い捨てコード生成スクリプト（通常ビルドには不要）。

## gen-logo.mjs — 「細流棋」ロゴの SVG 生成

`src/components/Logo.tsx` を再生成する。

### なぜ SVG か

ロゴは元々 Google Fonts の **WDXL Lubrifont JP N** で描画していたが、この
フォントは subset 配信されず **TTF 全体（約 10MB）** が読み込まれ、ロゴ 3 文字の
ためだけに重い初回転送コストが発生していた。該当グリフの輪郭のみを SVG パスに
焼き込み、Web フォントの読み込み自体を廃止した。

- 生成物: 約 7KB（gzip 後およそ 2.5KB）
- 効果: `index.html` からフォント `<link>` 3 行と `app.css` の `--font-logo` を撤去

### 使い方

依存は web の devDependency である `opentype.js` のみ。リポジトリのルートで実行する:

```bash
pnpm --filter web gen:logo
# 別ファミリ/別文字にする例:
LOGO_TEXT=詰将棋 FONT_FAMILY="Zen Maru Gothic" pnpm --filter web gen:logo
```

Google Fonts から現行 TTF を取得してグリフ輪郭を抽出するため、実行時はネットワークが必要。

### パラメータ（環境変数）

| 変数          | 既定                      | 説明                      |
| ------------- | ------------------------- | ------------------------- |
| `LOGO_TEXT`   | `細流棋`                  | 生成する文字列            |
| `FONT_FAMILY` | `WDXL Lubrifont JP N`     | Google Fonts のファミリ名 |
| `PRECISION`   | `1`                       | 座標の小数桁              |
| `OUT_PATH`    | `src/components/Logo.tsx` | 出力先（省略可）          |

### パスの簡略化について

座標系は em=1000 のフル解像度で出力する。フォントを丸ごと SVG 化した時点で
10MB → 約 7KB（gzip 後 ~2.5KB）と十分軽量なため、パスのこれ以上の削減はしない。
（整数化や em 縮小による削減も検証したが、効果は 1 割未満か、丸め由来の曲線退化で
グリフが壊れるため見送った。）
