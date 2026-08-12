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
import type { GrayImage } from './frame.ts';
import { resample, type Template } from './template.ts';

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
  /**
   * 代表的な切り出し寸法（1 枚目のもの）。人が中身を見るときの目安で、
   * **照合の可否を決めるものではない**。寸法は 1 枚ごとに持っている。
   */
  cellWidth: number;
  cellHeight: number;
  templates: StoredTemplate[];
}

/**
 * テンプレートを保存する。
 *
 * ⚠ **寸法を揃えることは求めない。** 出所によって切り出し寸法は変わる
 * （動画のマスは 61x66、外から受け取った解析画面の絵は 48x52）。
 * 揃えるために保存時に引き伸ばすと、**保存するたびに補間を重ねて絵が甘くなる**。
 * 元の寸法のまま置いておき、**読むときに必要な寸法へ合わせる**方がよい。
 */
export function saveTemplates(templates: Template[], path: string): void {
  if (templates.length === 0) throw new Error('保存するテンプレートがありません');
  const { width, height } = templates[0].img;

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
 * @param expected 現在のマス寸法。食い違うものは**引き伸ばして合わせる**。
 *   省略すると保存されたままの寸法で返す（保存し直すときはこちらを使う。
 *   引き伸ばした絵を書き戻すと補間が積み重なる）。
 *
 * ⚠ かつては寸法が食い違えば **null を返して丸ごと捨てていた**。
 * そのせいで「解像度の違う動画に使い回す」ことも「外から受け取った絵から
 * 起こす」こともできず、成駒テンプレートがいつまでも揃わなかった。
 * 駒の絵は拡大縮小しても字の形は保たれるので、合わせれば照合できる。
 */
export function loadTemplates(
  path: string,
  expected?: { width: number; height: number },
): Template[] | null {
  if (!existsSync(path)) return null;
  const store = JSON.parse(readFileSync(path, 'utf8')) as Store;
  return store.templates.map((t) => {
    const img: GrayImage = {
      width: t.width,
      height: t.height,
      data: new Uint8Array(Buffer.from(t.data, 'base64')),
    };
    return {
      kind: t.kind,
      side: t.side,
      samples: t.samples,
      img: expected ? resample(img, expected.width, expected.height) : img,
    };
  });
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
