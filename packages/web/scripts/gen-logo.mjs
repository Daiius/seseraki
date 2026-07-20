// 「細流棋」ロゴ SVG コンポーネント（src/components/Logo.tsx）の生成スクリプト。
//
// 背景:
//   ロゴは元々 Google Fonts の「WDXL Lubrifont JP N」で描画していたが、この
//   フォントは subset 配信されず TTF 全体（約 10MB）が読み込まれ、ロゴ 3 文字の
//   ためだけに大きな初回転送コストが発生していた。そこで該当グリフの輪郭のみを
//   SVG パスに焼き込み、Web フォントの読み込み自体を廃止した（約 7KB / gzip 後
//   約 2.5KB）。本スクリプトはその Logo.tsx を再生成するためのもの。
//
// やっていること:
//   1. Google Fonts CSS API から現行 TTF の URL を解決してダウンロード
//   2. opentype.js で対象文字のグリフ輪郭を取り出し、単一の SVG パスへ変換
//   3. バウンディングボックスから viewBox を算出し Logo.tsx を書き出す
//
// 前提: Node 18+（global fetch 使用）。依存は web の devDependency の opentype.js のみ。
//   実行（フォントや文字を変えたい時だけ。通常のビルドには不要）:
//     pnpm --filter web gen:logo
//   別ファミリ/別文字にする例:
//     LOGO_TEXT=詰将棋 FONT_FAMILY="Zen Maru Gothic" pnpm --filter web gen:logo
//
// パラメータ（環境変数で上書き可）:
//   LOGO_TEXT    生成する文字列（既定: 細流棋）
//   FONT_FAMILY  Google Fonts のファミリ名（既定: WDXL Lubrifont JP N）
//   PRECISION    座標の小数桁（既定: 1）。座標系は em=1000 のフル解像度で出力する
//                （フォントを丸ごと SVG 化する時点で十分軽量なため、これ以上の
//                削減はしない方針）。

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import opentype from 'opentype.js';

const LOGO_TEXT = process.env.LOGO_TEXT ?? '細流棋';
const FONT_FAMILY = process.env.FONT_FAMILY ?? 'WDXL Lubrifont JP N';
const PRECISION = Number(process.env.PRECISION ?? '1');
const UNITS_PER_EM = 1000; // フル解像度で出力する
const PAD_RATIO = 0.03; // viewBox の余白（em 比）

const outPath =
  process.env.OUT_PATH ??
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../src/components/Logo.tsx',
  );

async function resolveTtfUrl(family) {
  const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(
    family,
  ).replace(/%20/g, '+')}&display=swap`;
  const css = await (await fetch(url)).text();
  const m = css.match(/url\((https:\/\/[^)]+\.ttf)\)/);
  if (!m) throw new Error(`TTF URL not found in CSS for "${family}"`);
  return m[1];
}

async function main() {
  console.log(`Resolving font "${FONT_FAMILY}" ...`);
  const ttfUrl = await resolveTtfUrl(FONT_FAMILY);
  console.log(`  ttf: ${ttfUrl}`);
  const buf = await (await fetch(ttfUrl)).arrayBuffer();
  console.log(`  downloaded ${(buf.byteLength / 1024 / 1024).toFixed(1)} MB`);

  const font = opentype.parse(buf);
  const path = font.getPath(LOGO_TEXT, 0, 0, UNITS_PER_EM);
  const d = path.toPathData(PRECISION);
  const bb = path.getBoundingBox();

  const pad = UNITS_PER_EM * PAD_RATIO;
  const x = Math.floor(bb.x1 - pad);
  const y = Math.floor(bb.y1 - pad);
  const w = Math.ceil(bb.x2 - bb.x1 + pad * 2);
  const h = Math.ceil(bb.y2 - bb.y1 + pad * 2);
  const viewBox = `${x} ${y} ${w} ${h}`;

  const tsx = `// 自動生成: packages/web/scripts/gen-logo.mjs（手で編集しない）
// 文字「${LOGO_TEXT}」を ${FONT_FAMILY} のグリフ輪郭から焼き込んだロゴ。
// 経緯・再生成手順は同スクリプトのヘッダを参照。

interface LogoProps {
  /** 追加クラス（色は currentColor を継承） */
  className?: string;
}

/**
 * 「${LOGO_TEXT}」ロゴ。Web フォントを読み込まず、グリフ輪郭を SVG パスとして
 * 埋め込む。高さは font-size（1em）に追従し、色は currentColor を継承する。
 */
export function Logo({ className }: LogoProps) {
  return (
    <svg
      viewBox="${viewBox}"
      role="img"
      aria-label="${LOGO_TEXT}"
      className={className}
      style={{ height: '1em', width: 'auto' }}
    >
      <path fill="currentColor" d="${d}" />
    </svg>
  );
}
`;

  writeFileSync(outPath, tsx);
  console.log(
    `Wrote ${outPath}\n  viewBox="${viewBox}"  path=${d.length}B (precision=${PRECISION})`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
