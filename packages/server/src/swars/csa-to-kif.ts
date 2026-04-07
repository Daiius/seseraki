export interface SwarsMove {
  m: string; // CSA: "+7776FU"
  t: number; // remaining time (sec)
  n: number; // move number (0-indexed)
}

export interface SwarsGameData {
  name: string;
  sente: string;
  gote: string;
  sente_dan: number;
  gote_dan: number;
  result: string;
  gtype: string;
  handicap: number;
  moves: SwarsMove[];
}

// CSA 駒コード → KIF 駒名
const CSA_PIECE: Record<string, string> = {
  FU: '歩', KY: '香', KE: '桂', GI: '銀', KI: '金', KA: '角', HI: '飛',
  OU: '玉',
  TO: 'と', NY: '成香', NK: '成桂', NG: '成銀', UM: '馬', RY: '龍',
};

// 列(column) → 全角数字
const COL_ZENKAKU = ['', '１', '２', '３', '４', '５', '６', '７', '８', '９'];

// 段(row) → 漢数字
const ROW_KANJI = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

// CSA 手のパース: "+7776FU" → { sign, fromCol, fromRow, toCol, toRow, piece }
function parseCsaMove(m: string) {
  const sign = m[0]; // "+" or "-"
  const fromCol = Number(m[1]);
  const fromRow = Number(m[2]);
  const toCol = Number(m[3]);
  const toRow = Number(m[4]);
  const piece = m.slice(5);
  return { sign, fromCol, fromRow, toCol, toRow, piece };
}

export function swarsToKif(game: SwarsGameData): string {
  const lines: string[] = [];

  // KIF ヘッダー
  lines.push('手合割：平手');
  lines.push(`先手：${game.sente}`);
  lines.push(`後手：${game.gote}`);
  lines.push('手数----指手---------消費時間--');

  let prevToCol = 0;
  let prevToRow = 0;

  for (const move of game.moves) {
    const { fromCol, fromRow, toCol, toRow, piece } = parseCsaMove(move.m);
    const moveNum = move.n + 1; // 1-indexed
    const pieceName = CSA_PIECE[piece];
    if (!pieceName) continue;

    const isDrop = fromCol === 0 && fromRow === 0;
    const isSame = toCol === prevToCol && toRow === prevToRow;

    // 移動先の表記
    let dest: string;
    if (isSame) {
      dest = '同　';
    } else {
      dest = `${COL_ZENKAKU[toCol]}${ROW_KANJI[toRow]}`;
    }

    // 指し手行の組み立て
    let moveLine: string;
    if (isDrop) {
      moveLine = `${dest}${pieceName}打`;
    } else {
      moveLine = `${dest}${pieceName}(${fromCol}${fromRow})`;
    }

    const numStr = String(moveNum).padStart(4, ' ');
    lines.push(`${numStr} ${moveLine}   ( 0:00/00:00:00)`);

    prevToCol = toCol;
    prevToRow = toRow;
  }

  // 結果行
  const resultLine = formatResult(game.result);
  if (resultLine) {
    const numStr = String(game.moves.length + 1).padStart(4, ' ');
    lines.push(`${numStr} ${resultLine}   ( 0:00/00:00:00)`);
  }

  return lines.join('\n') + '\n';
}

function formatResult(result: string): string | null {
  if (result.includes('CHECKMATE')) return '投了';
  if (result.includes('TIMEOUT')) return '切れ負け';
  if (result.includes('RESIGN')) return '投了';
  if (result.includes('DRAW')) return '千日手';
  return '投了';
}

/** swarsGameKey (e.g. "user1-user2-20260401_123456") から対局日時を抽出 */
export function parsePlayedAt(gameKey: string): Date | null {
  const m = gameKey.match(/(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/);
  if (!m) return null;
  return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+09:00`);
}

export function formatTitle(game: SwarsGameData): string {
  const gtypeLabel =
    { '': '10分', sb: '3分', s1: '10秒' }[game.gtype] ?? game.gtype;
  return `${game.sente} vs ${game.gote} (${gtypeLabel})`;
}
