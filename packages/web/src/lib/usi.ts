const BLUNDER_THRESHOLD = 300;

/**
 * 悪手の手番セットを算出する。
 * 悪手条件: 手番側にとって評価値が BLUNDER_THRESHOLD 以上悪化し、かつ実手が候補手リストに含まれていない。
 */
export function detectBlunders(
  analyses: {
    moveNumber: number;
    candidates: { rank: number; move: string; scoreType: string; scoreValue: number }[];
  }[],
  usiMoves: string[],
): Set<number> {
  const blunders = new Set<number>();
  const sorted = [...analyses]
    .filter((a) => a.candidates.length > 0)
    .sort((a, b) => a.moveNumber - b.moveNumber);

  for (let i = 0; i < sorted.length - 1; i++) {
    const curr = sorted[i];
    const next = sorted[i + 1];
    // curr.moveNumber の局面で指された手が悪手かを判定
    // next.moveNumber が curr.moveNumber + 1 でなければスキップ
    if (next.moveNumber !== curr.moveNumber + 1) continue;

    const currBest = curr.candidates.find((c) => c.rank === 1);
    const nextBest = next.candidates.find((c) => c.rank === 1);
    if (!currBest || !nextBest) continue;

    // 先手視点の評価値
    const currVal = toSenteEval(currBest.scoreType, currBest.scoreValue, curr.moveNumber);
    const nextVal = toSenteEval(nextBest.scoreType, nextBest.scoreValue, next.moveNumber);

    // 手番側にとっての変化量（先手番=偶数: 下がったら悪い、後手番=奇数: 上がったら悪い）
    const isSenteTurn = curr.moveNumber % 2 === 0;
    const drop = isSenteTurn ? currVal - nextVal : nextVal - currVal;

    if (drop < BLUNDER_THRESHOLD) continue;

    // 実手が候補手リストに含まれている場合は悪手としない
    const played = usiMoves[curr.moveNumber];
    if (!played) continue;
    const playedInCandidates = curr.candidates.some((c) => c.move === played);
    if (playedInCandidates) continue;

    blunders.add(curr.moveNumber);
  }

  return blunders;
}

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
 * 評価値を人間が読みやすい形式にフォーマット
 * 常に先手視点で表示（後手番のスコアは符号反転）
 */
export function formatScore(
  scoreType: string,
  scoreValue: number,
  moveNumber: number,
): string {
  // 後手番（奇数手目）のスコアは反転して先手視点にする
  const senteValue = moveNumber % 2 === 1 ? -scoreValue : scoreValue;

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
