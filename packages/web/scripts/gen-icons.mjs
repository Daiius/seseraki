// ホーム画面・favicon 用のアイコンを生成するスクリプト（prd/02-architecture.md §8）。
//
// 原本は SVG（駒の形の五角形に「細」1 文字）。文字はロゴ（src/components/Logo.tsx）に焼き込んである
// グリフ輪郭の先頭の 1 字を流用するので、フォントを読み込まない。
//
// 1. SVG を書く（依存なし）:  pnpm --filter web gen:icons
//      icons/icon.svg           … any / apple-touch-icon 用（背景つき・全面）
//      icons/icon-maskable.svg  … maskable 用（駒を安全域の円 = 直径 80% の内側に収める）
//      public/favicon.svg       … favicon（背景なし。そのまま配信する）
// 2. PNG も書き出す: 手元の Chrome（headless）を CHROME に渡す。リポジトリに依存は足さない
//      CHROME=~/.cache/ms-playwright/chromium_headless_shell-<版>/chrome-headless-shell-linux64/chrome-headless-shell pnpm --filter web gen:icons
//    （Playwright が置いた headless shell でも、普通の Chrome / Chromium でもよい。成果物の PNG はコミットする）

import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const iconsDir = join(root, 'icons');
const publicDir = join(root, 'public');

// 色。背景は daisyUI の dark の base-100（#1d232a）。駒は木地の色
const BG = '#1d232a';
const WOOD = '#f0c977';
const EDGE = '#9a6a2c';
const INK = '#1f1a14';

// ---- 「細」のグリフ輪郭を Logo.tsx から取り出す ----
// Logo.tsx の path は 3 字ぶんの輪郭を絶対座標（M / L / Q / Z）で連ねたもの。
// 先頭の字（細）の輪郭は x < 800 から始まる部分パス（2 字目は x = 846 から）。
const logo = readFileSync(join(root, 'src/components/Logo.tsx'), 'utf8');
const d = logo.match(/\sd="([^"]+)"/)[1];
const subpaths = d
  .split(/(?=M)/)
  .filter((s) => Number(s.match(/^M(-?[\d.]+)/)[1]) < 800);
const glyphD = subpaths.join('');
const nums = glyphD.match(/-?\d*\.?\d+/g).map(Number);
const xs = nums.filter((_, i) => i % 2 === 0);
const ys = nums.filter((_, i) => i % 2 === 1);
const gb = {
  x1: Math.min(...xs),
  x2: Math.max(...xs),
  y1: Math.min(...ys),
  y2: Math.max(...ys),
};

/**
 * 駒（五角形）と文字を、中心 (cx, cy)・高さ h で描く。
 * 頂点は高さ 1 に対し 頂 (0, -0.5) / 肩 (±0.36, -0.3) / 裾 (±0.44, 0.5)。
 * 中心から最も遠い点は裾の角（距離 ≈ 0.666h）。
 */
function koma(cx, cy, h) {
  const p = (x, y) => `${(cx + x * h).toFixed(1)},${(cy + y * h).toFixed(1)}`;
  const points = [
    p(0, -0.5),
    p(0.36, -0.3),
    p(0.44, 0.5),
    p(-0.44, 0.5),
    p(-0.36, -0.3),
  ].join(' ');
  const stroke = (h * 0.03).toFixed(1);
  // 文字は駒の下寄り（実物の駒と同じく、肩より下の広い部分に置く）
  const gw = gb.x2 - gb.x1;
  const gh = gb.y2 - gb.y1;
  const s = Math.min((0.56 * h) / gw, (0.56 * h) / gh);
  const tx = cx - ((gb.x1 + gb.x2) / 2) * s;
  const ty = cy + 0.08 * h - ((gb.y1 + gb.y2) / 2) * s;
  return [
    `<polygon points="${points}" fill="${WOOD}" stroke="${EDGE}" stroke-width="${stroke}" stroke-linejoin="round"/>`,
    `<path fill="${INK}" transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${s.toFixed(5)})" d="${glyphD}"/>`,
  ].join('\n  ');
}

const svg = (size, body, bg) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
  ${bg ? `<rect width="${size}" height="${size}" fill="${bg}"/>\n  ` : ''}${body}
</svg>
`;

// any / apple-touch-icon: 駒の高さ 80%
const icon = svg(512, koma(256, 256, 512 * 0.8), BG);
// maskable: 裾の角（中心から 0.666h）が安全域の円（半径 40%）の内側に入るよう、半径 38% に収める
const maskable = svg(512, koma(256, 256, (512 * 0.38) / 0.666), BG);
// favicon: 背景なし。小さく表示されるので枠いっぱいに
const favicon = svg(32, koma(16, 16, 31), null);

mkdirSync(iconsDir, { recursive: true });
mkdirSync(publicDir, { recursive: true });
writeFileSync(join(iconsDir, 'icon.svg'), icon);
writeFileSync(join(iconsDir, 'icon-maskable.svg'), maskable);
writeFileSync(join(publicDir, 'favicon.svg'), favicon);
console.log(
  'wrote icons/icon.svg, icons/icon-maskable.svg, public/favicon.svg',
);

// ---- PNG の書き出し（CHROME があるときだけ） ----
const chrome = process.env.CHROME;
if (!chrome) {
  console.log(
    'CHROME が未設定なので PNG は書き出さない（スクリプト冒頭の手順を参照）',
  );
  process.exit(0);
}

const targets = [
  { src: icon, out: 'apple-touch-icon.png', size: 180, transparent: false },
  { src: icon, out: 'icon-192.png', size: 192, transparent: false },
  { src: icon, out: 'icon-512.png', size: 512, transparent: false },
  {
    src: maskable,
    out: 'icon-maskable-512.png',
    size: 512,
    transparent: false,
  },
  { src: favicon, out: 'favicon-32.png', size: 32, transparent: true },
];
const work = mkdtempSync(join(tmpdir(), 'seseraki-icons-'));
try {
  for (const t of targets) {
    const svgPath = join(work, `${t.out}.svg`);
    const htmlPath = join(work, `${t.out}.html`);
    writeFileSync(svgPath, t.src);
    writeFileSync(
      htmlPath,
      `<!doctype html><html><body style="margin:0;background:transparent"><img src="${t.out}.svg" width="${t.size}" height="${t.size}" style="display:block"></body></html>`,
    );
    execFileSync(
      chrome,
      [
        '--headless',
        '--disable-gpu',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        ...(t.transparent ? ['--default-background-color=00000000'] : []),
        `--window-size=${t.size},${t.size}`,
        `--screenshot=${join(publicDir, t.out)}`,
        `file://${htmlPath}`,
      ],
      { stdio: 'ignore' },
    );
    console.log(`wrote public/${t.out} (${t.size}px)`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
