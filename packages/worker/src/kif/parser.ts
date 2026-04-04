/**
 * KIF 形式の棋譜テキストを解析し、USI 形式の指し手列に変換する
 *
 * KIF 指し手例: "７六歩(77)" → USI: "7g7f"
 * KIF 駒打ち例: "５五角打"   → USI: "B*5e"
 * KIF 成り例:   "２二角成(88)" → USI: "8h2b+"
 * KIF 同:       "同　歩(34)"  → 前の手の移動先を使う
 */

// 全角数字 → 数値
const ZENKAKU_MAP: Record<string, number> = {
  "１": 1, "２": 2, "３": 3, "４": 4, "５": 5,
  "６": 6, "７": 7, "８": 8, "９": 9,
};

// 漢数字 → 数値
const KANJI_MAP: Record<string, number> = {
  "一": 1, "二": 2, "三": 3, "四": 4, "五": 5,
  "六": 6, "七": 7, "八": 8, "九": 9,
};

// 段(row) 数値 → USI アルファベット (1段=a, 9段=i)
function rowToUsi(row: number): string {
  return String.fromCharCode("a".charCodeAt(0) + row - 1);
}

// 駒名 → USI 駒文字（駒打ち用）
const PIECE_USI: Record<string, string> = {
  "歩": "P", "香": "L", "桂": "N", "銀": "S",
  "金": "G", "角": "B", "飛": "R",
};

// KIF 指し手行の正規表現
// グループ: (手数)(全角列?)(漢数字段?)(同?)(駒名)(成|不成)?(打)?(移動元)?
// ※ 漢数字は Unicode 上で連続しないため列挙する
const MOVE_RE =
  /^\s*(\d+)\s+(([１２３４５６７８９])([一二三四五六七八九])|同\s*)(歩|香|桂|銀|金|角|飛|王|玉|と|成香|成桂|成銀|馬|龍|竜)(成|不成)?(打)?(?:\((\d{2})\))?/;

export interface KifMove {
  /** 手数 (1-indexed) */
  moveNumber: number;
  /** USI 形式の指し手 (例: "7g7f", "B*5e", "8h2b+") */
  usi: string;
}

export interface ParsedKif {
  moves: KifMove[];
  /** パースに失敗した行 */
  errors: { line: number; text: string; reason: string }[];
}

export function parseKif(kifText: string): ParsedKif {
  const lines = kifText.split("\n");
  const moves: KifMove[] = [];
  const errors: ParsedKif["errors"] = [];

  let prevCol = 0;
  let prevRow = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 手数で始まらない行はスキップ（ヘッダー、コメント等）
    if (!/^\s*\d+\s/.test(line)) continue;

    // 「投了」「中断」「千日手」等の終局
    if (/投了|中断|千日手|持将棋|反則/.test(line)) continue;

    const m = MOVE_RE.exec(line);
    if (!m) {
      errors.push({ line: i + 1, text: line.trim(), reason: "パース失敗" });
      continue;
    }

    const moveNumber = Number(m[1]);
    const isSame = line.includes("同"); // 同X
    const colStr = m[3]; // 全角数字 (列)
    const rowStr = m[4]; // 漢数字 (段)
    const promote = m[6] === "成";
    const isDrop = !!m[7]; // 打
    const fromStr = m[8]; // 移動元 e.g. "77"
    const pieceName = m[5];

    // 移動先の決定
    let destCol: number;
    let destRow: number;

    if (isSame) {
      destCol = prevCol;
      destRow = prevRow;
    } else if (colStr && rowStr) {
      destCol = ZENKAKU_MAP[colStr];
      destRow = KANJI_MAP[rowStr];
    } else {
      errors.push({ line: i + 1, text: line.trim(), reason: "移動先不明" });
      continue;
    }

    let usi: string;

    if (isDrop) {
      // 駒打ち: "P*5e"
      const pieceUsi = PIECE_USI[pieceName];
      if (!pieceUsi) {
        errors.push({
          line: i + 1,
          text: line.trim(),
          reason: `駒打ち駒名不明: ${pieceName}`,
        });
        continue;
      }
      usi = `${pieceUsi}*${destCol}${rowToUsi(destRow)}`;
    } else if (fromStr) {
      // 通常の移動: "7g7f" or "8h2b+"
      const fromCol = Number(fromStr[0]);
      const fromRow = Number(fromStr[1]);
      usi =
        `${fromCol}${rowToUsi(fromRow)}${destCol}${rowToUsi(destRow)}` +
        (promote ? "+" : "");
    } else {
      errors.push({
        line: i + 1,
        text: line.trim(),
        reason: "移動元なし（打でもない）",
      });
      continue;
    }

    moves.push({ moveNumber, usi });
    prevCol = destCol;
    prevRow = destRow;
  }

  return { moves, errors };
}
