/**
 * 駒テンプレートの保存と読み込み
 *
 * 生駒は平手初期局面から毎回作り直せるが、**成駒はそうはいかない**。
 * 初期局面に無いので、手の整合性から逆算するか、外から与えるしかない。
 * 一度手に入れたものは失いたくないので、ファイルに残して使い回す。
 *
 * 画面レイアウトが 1〜2 年変わらないなら、**同じチャンネルの他の動画にも
 * そのまま使える**。1 度作れば済む種類の資産である。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PieceKind, Side } from 'shared';
import type { Template } from './template.ts';

interface StoredTemplate {
  kind: PieceKind;
  side: Side;
  width: number;
  height: number;
  samples: number;
  /** 画素をそのまま base64 にしたもの */
  data: string;
}

interface Store {
  /** どの寸法で切り出したテンプレートか。合わない相手とは照合できない。 */
  cellWidth: number;
  cellHeight: number;
  templates: StoredTemplate[];
}

export function saveTemplates(templates: Template[], path: string): void {
  if (templates.length === 0) throw new Error('保存するテンプレートがありません');
  const { width, height } = templates[0].img;
  for (const t of templates) {
    if (t.img.width !== width || t.img.height !== height) {
      throw new Error(`寸法が揃っていません: ${t.kind} が ${t.img.width}x${t.img.height}`);
    }
  }

  const store: Store = {
    cellWidth: width,
    cellHeight: height,
    templates: templates.map((t) => ({
      kind: t.kind,
      side: t.side,
      width: t.img.width,
      height: t.img.height,
      samples: t.samples,
      data: Buffer.from(t.img.data).toString('base64'),
    })),
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store));
}

/**
 * 保存したテンプレートを読む。
 *
 * @param expected 現在のマス寸法。食い違えば照合できないので null を返す
 *   （動画の解像度やレイアウトが変わったということ）。
 */
export function loadTemplates(
  path: string,
  expected?: { width: number; height: number },
): Template[] | null {
  if (!existsSync(path)) return null;
  const store = JSON.parse(readFileSync(path, 'utf8')) as Store;
  if (expected && (store.cellWidth !== expected.width || store.cellHeight !== expected.height)) {
    return null;
  }
  return store.templates.map((t) => ({
    kind: t.kind,
    side: t.side,
    samples: t.samples,
    img: {
      width: t.width,
      height: t.height,
      data: new Uint8Array(Buffer.from(t.data, 'base64')),
    },
  }));
}

/** 既にある種類は入れ替えず、無いものだけ足す */
export function mergeTemplates(base: Template[], extra: Template[]): Template[] {
  const out = [...base];
  for (const t of extra) {
    if (out.some((b) => b.kind === t.kind && b.side === t.side)) continue;
    out.push(t);
  }
  return out;
}
