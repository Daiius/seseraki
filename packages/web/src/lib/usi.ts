/**
 * 保存値（手番視点）を先手視点へ正規化し、±3000 にクランプする。
 * **表示用途に限る**——悪手判定（CPL）は同一局面内で最善手と実手を比べるため
 * 正規化も符号反転も要らない（`lib/cpl.ts`）。
 */
export function toSenteEval(scoreType: string, scoreValue: number, moveNumber: number): number {
  const v = moveNumber % 2 === 1 ? -scoreValue : scoreValue;
  if (scoreType === 'mate') return v > 0 ? 3000 : -3000;
  return Math.max(-3000, Math.min(3000, v));
}

const COL_MAP: Record<string, string> = {
  '1': '１',
  '2': '２',
  '3': '３',
  '4': '４',
  '5': '５',
  '6': '６',
  '7': '７',
  '8': '８',
  '9': '９',
};

// USI row (a-i) → 漢数字 (一-九)
const ROW_MAP: Record<string, string> = {
  a: '一',
  b: '二',
  c: '三',
  d: '四',
  e: '五',
  f: '六',
  g: '七',
  h: '八',
  i: '九',
};

// USI row (a-i) → 算用数字 (1-9)
const ROW_NUM: Record<string, string> = {
  a: '1',
  b: '2',
  c: '3',
  d: '4',
  e: '5',
  f: '6',
  g: '7',
  h: '8',
  i: '9',
};

const PIECE_MAP: Record<string, string> = {
  P: '歩',
  L: '香',
  N: '桂',
  S: '銀',
  G: '金',
  B: '角',
  R: '飛',
};

/**
 * USI 表記を簡易日本語表記に変換
 *
 * - "7g7f"   → "７六(77)"
 * - "7g7f+"  → "７六成(77)"
 * - "B*5c"   → "５三角打"
 */
export function usiToJapanese(usi: string): string {
  // 駒打ち: "B*5c"
  const dropMatch = usi.match(/^([PLNSGBR])\*(\d)([a-i])$/);
  if (dropMatch) {
    const [, piece, col, row] = dropMatch;
    return `${COL_MAP[col]}${ROW_MAP[row]}${PIECE_MAP[piece]}打`;
  }

  // 通常の移動: "7g7f" or "7g7f+"
  const moveMatch = usi.match(/^(\d)([a-i])(\d)([a-i])(\+?)$/);
  if (moveMatch) {
    const [, fromCol, fromRow, toCol, toRow, promote] = moveMatch;
    const dest = `${COL_MAP[toCol]}${ROW_MAP[toRow]}`;
    const from = `${fromCol}${ROW_NUM[fromRow]}`;
    const suffix = promote ? '成' : '';
    return `${dest}${suffix}(${from})`;
  }

  return usi;
}

/**
 * 手番記号を返す
 * moveNumber 0 = 初期局面（先手番）、1 = 先手が指した後（後手番）...
 * moveNumber が偶数なら先手（▲）、奇数なら後手（△）
 */
export function turnSymbol(moveNumber: number): string {
  return moveNumber % 2 === 0 ? '▲' : '△';
}

/**
 * **先手視点に直したあとの値**を読みやすい文字列にする。
 * 視点をどう作るかは呼び出し側の責務（棋譜は手数の parity・検討盤は手番）。
 */
function describeSenteScore(scoreType: string, senteValue: number): string {
  if (scoreType === 'mate') {
    if (senteValue > 0) return `先手勝ち(${senteValue}手詰)`;
    if (senteValue < 0) return `後手勝ち(${-senteValue}手詰)`;
    return '詰み';
  }

  const abs = Math.abs(senteValue);
  let label = '';
  if (abs < 100) label = '互角';
  else if (abs < 300) label = senteValue > 0 ? '先手有利' : '後手有利';
  else if (abs < 800) label = senteValue > 0 ? '先手優勢' : '後手優勢';
  else label = senteValue > 0 ? '先手勝勢' : '後手勝勢';

  const sign = senteValue > 0 ? '+' : '';
  return `${sign}${senteValue} (${label})`;
}

/**
 * 評価値を人間が読みやすい形式にフォーマット
 * 常に先手視点で表示（後手番のスコアは符号反転）
 */
export function formatScore(
  scoreType: string,
  scoreValue: number,
  moveNumber: number,
): string {
  // 後手番（奇数手目）のスコアは反転して先手視点にする
  return describeSenteScore(scoreType, moveNumber % 2 === 1 ? -scoreValue : scoreValue);
}

/**
 * **手番側から見た**評価値の整形（prd/12 §2.3）。検討盤で使う。
 *
 * 🔴 **`formatScore` / `toSenteEval` は使えない。** あちらは棋譜の手数の parity
 * （`moveNumber % 2`）で先手視点へ正規化するが、検討盤の局面は棋譜から派生した
 * 任意局面で**手数を持たない**（手番トグルで手番だけ変えることもできる）。
 * 視点の情報は `sideToMove` から取る。
 *
 * 表示の文言は `formatScore` と揃える（同じ画面に両方が出るため）。返す値は
 * 常に先手視点の言葉（`+120 (先手有利)`）で、**「手番側が +」という生の符号を
 * そのまま出さない**——検討盤は手番を自由に変えられるので、どちら側の話かを
 * 言葉で書かないと読み違える。
 */
export function formatTurnScore(
  scoreType: string,
  scoreValue: number,
  sideToMove: 'sente' | 'gote',
): string {
  return describeSenteScore(
    scoreType,
    sideToMove === 'gote' ? -scoreValue : scoreValue,
  );
}

/**
 * USI の手から移動先の `[row, col]`（`BoardState.board` の添字）を取る。
 * 駒打ち（`B*5c`）も移動（`7g7f` / `7g7f+`）も受ける。読めなければ null。
 */
export function moveDestination(usiMove: string): [number, number] | null {
  // 駒打ち: "B*5c" → "5c"
  const dropMatch = usiMove.match(/^[PLNSGBR]\*(\d[a-i])$/);
  if (dropMatch) {
    const col = 9 - Number(dropMatch[1][0]);
    const row = dropMatch[1].charCodeAt(1) - 97;
    return [row, col];
  }
  // 通常の移動: "7g7f" or "7g7f+" → "7f"
  const moveMatch = usiMove.match(/^\d[a-i](\d[a-i])\+?$/);
  if (moveMatch) {
    const col = 9 - Number(moveMatch[1][0]);
    const row = moveMatch[1].charCodeAt(1) - 97;
    return [row, col];
  }
  return null;
}

/**
 * 狭い画面向けの短い評価値表示（prd/05-analysis.md §2.1）。
 *
 * 情報行は折り返せない（折り返すと下の操作ボタンがずれる）ため、幅が足りないときは符号か評価値を
 * 削ることになる。削って読めなくするより**そもそも削らずに済む情報量にする**方を採り、
 * 形勢判断の言葉（`(先手有利)` など）を落とす。
 *
 * 🔒 **どちらが勝つかは落とさない。**
 * - **cp は符号が勝者を担う**ので、言葉を落としても情報は減らない（`+120`）。
 * - **mate は言葉だけが勝者を担う**（`先手勝ち(13手詰)` と `後手勝ち(13手詰)` は語しか違わない）。
 *   手数だけにすると**頓死の前後で数字が変わるだけになり、勝敗が入れ替わったことが出ない**ので、
 *   手番記号に揃えた 1 文字（▲ / △ = 詰ます側）を残す。
 *
 * ⚠ **`formatScore`（広い画面・候補手の行で使う既定の形）は変えない。** 呼び分けは表示側で行う。
 */
export function formatScoreShort(
  scoreType: string,
  scoreValue: number,
  moveNumber: number,
): string {
  // 後手番（奇数手目）のスコアは反転して先手視点にする（`formatScore` と同じ）
  const senteValue = moveNumber % 2 === 1 ? -scoreValue : scoreValue;

  if (scoreType === 'mate') {
    // ▲ / △ は「詰ます側」。0 手詰（既に詰んでいる）と値が壊れている場合は
    // `formatScore` と同じく勝者を名乗らない
    if (senteValue > 0) return `▲${senteValue}手詰`;
    if (senteValue < 0) return `△${-senteValue}手詰`;
    return '詰み';
  }

  const sign = senteValue > 0 ? '+' : '';
  return `${sign}${senteValue}`;
}
