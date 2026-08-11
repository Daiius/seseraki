/**
 * 盤面の画面座標
 *
 * 対象は「画面レイアウトが固定されたアプリの録画」なので、盤の位置と
 * マスサイズは動画をまたいで一定になる。実物の盤を撮った写真と違い
 * 射影変換も照明補正も要らず、1 度測った定数を使い回せる。
 *
 * マスの添字は shared/board.ts の `board[row][col]` と同じ取り方にしてある
 * （row 0 = 一段目 = 画面の上端、col 0 = 9筋 = 画面の左端）。
 * 画面の並びと配列の並びが一致するので、座標変換を挟まずに済む。
 */

export interface BoardGeometry {
  /** 盤の左端（9筋の左辺）の x */
  originX: number;
  /** 盤の上端（一段目の上辺）の y */
  originY: number;
  /** マスの幅 */
  cellW: number;
  /** マスの高さ */
  cellH: number;
  /** この座標が前提とするフレームの寸法 */
  frameW: number;
  frameH: number;
}

/**
 * 将棋ウォーズ・縦画面（1080x1920）
 *
 * 9x9 の格子を輝度に当てはめて求めた値。格子線は暗い細線なので、
 * 「等間隔な 10 本の線上の輝度合計が最小になる (原点, 間隔)」を探して得た。
 */
export const SHOGI_WARS_VERTICAL: BoardGeometry = {
  originX: 4.25,
  originY: 381.25,
  cellW: 118.4,
  cellH: 128.7,
  frameW: 1080,
  frameH: 1920,
};

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * マス [row][col] の矩形を返す。
 *
 * `inset` はマスの内側へ縮める割合（0〜0.5）。格子線と隣のマスの駒の
 * はみ出しを避けたいときに使う。駒はマスをほぼ覆うので、少し内側を
 * 見る方が「盤の背景」の影響を受けにくい。
 */
export function cellRect(
  geo: BoardGeometry,
  row: number,
  col: number,
  inset = 0,
): Rect {
  const mx = geo.cellW * inset;
  const my = geo.cellH * inset;
  return {
    x: Math.round(geo.originX + geo.cellW * col + mx),
    y: Math.round(geo.originY + geo.cellH * row + my),
    w: Math.round(geo.cellW - mx * 2),
    h: Math.round(geo.cellH - my * 2),
  };
}

/** 盤全体を覆う矩形（変化検出のための crop に使う） */
export function boardRect(geo: BoardGeometry): Rect {
  return {
    x: Math.round(geo.originX),
    y: Math.round(geo.originY),
    w: Math.round(geo.cellW * 9),
    h: Math.round(geo.cellH * 9),
  };
}

/**
 * 持ち駒が並ぶ帯（盤の外・画面の上下端寄り）
 *
 * 行ごとの平均輝度を取ると、盤（y=368..1538）の上下にもう 2 本の明るい帯が
 * 出る。それがこの領域で、実際に切り出すと持ち駒が並んでいることを確認した。
 *
 * 並び方には向きがある。**下（手前・投稿者側）は左詰め、上（相手側）は右詰め**で、
 * 中央のボタン類に向かって伸びる。枚数は駒の右下に小さな数字で出るが、
 * 1 枚のときは数字が出ない。
 *
 * ⚠ 帯には対局者情報（顔・段位・時計）と「投了」「棋神」ボタンも入っている。
 * 持ち駒だけを見るには x 方向をさらに絞る必要があり、その範囲はまだ測っていない。
 *
 * 持ち駒は**読めなくても棋譜は復元できる**（初期局面から手を追えば確定する）。
 * ただし読めれば、追跡で得た持ち駒と突き合わせることで**手の取りこぼしを
 * 独立に検出**できる。検算の材料として価値がある。
 */
export interface HandAreas {
  /** 相手（画面上側）の持ち駒帯。右詰めで並ぶ。 */
  top: Rect;
  /** 自分（画面下側）の持ち駒帯。左詰めで並ぶ。 */
  bottom: Rect;
}

export const SHOGI_WARS_VERTICAL_HANDS: HandAreas = {
  top: { x: 0, y: 165, w: 1080, h: 174 },
  bottom: { x: 0, y: 1586, w: 1080, h: 149 },
};
