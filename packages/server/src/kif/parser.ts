/**
 * KIF 形式の棋譜テキストを解析し、USI 形式の指し手列と対局メタを取り出す
 *
 * KIF 指し手例: "７六歩(77)" → USI: "7g7f"
 * KIF 駒打ち例: "５五角打"   → USI: "B*5e"
 * KIF 成り例:   "２二角成(88)" → USI: "8h2b+"
 * KIF 同:       "同　歩(34)"  → 前の手の移動先を使う
 * KIF 成駒略記: "８四全(83)"   → 成銀の移動（`全`=成銀 / `圭`=成桂 / `杏`=成香）
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

// 成駒名 → 成り前の駒名（駒名が成り後になっている場合の成り検出用）
// KIF では「４八馬(37)」のように移動先の駒名が成り後の名前になる表記がある。
// 成銀/成桂/成香 は一文字略記（全/圭/杏）でも書かれる。
const PROMOTED_TO_BASE: Record<string, string> = {
  "と": "歩",
  "成香": "香", "杏": "香",
  "成桂": "桂", "圭": "桂",
  "成銀": "銀", "全": "銀",
  "馬": "角", "龍": "飛", "竜": "飛",
};

// KIF 指し手行の正規表現
// グループ: (手数)(全角列?)(漢数字段?)(同?)(駒名)(成|不成)?(打)?(移動元)?
// ※ 漢数字は Unicode 上で連続しないため列挙する
// ※ 成駒の一文字略記（全/圭/杏）と成香/成桂/成銀 の複数字表記の両方を受ける
const MOVE_RE =
  /^\s*(\d+)\s+(([１２３４５６７８９])([一二三四五六七八九])|同\s*)(成香|成桂|成銀|歩|香|桂|銀|金|角|飛|王|玉|と|杏|圭|全|馬|龍|竜)(成|不成)?(打)?(?:\((\d{2})\))?/;

// 終局マーカー（このいずれかを含む指し手行で棋譜は終わる。以降の分岐ブロック等は読まない）
// ※ 「反則勝ち/反則負け」は「反則」より先に判定するため順序に注意
const TERMINAL_MARKERS = [
  "反則勝ち", "反則負け", "反則",
  "投了", "詰み", "中断", "千日手", "持将棋", "入玉宣言",
  "切れ負け", "時間切れ",
] as const;

export interface KifMove {
  /** 手数 (1-indexed) */
  moveNumber: number;
  /** USI 形式の指し手 (例: "7g7f", "B*5e", "8h2b+") */
  usi: string;
}

/**
 * 開始日時ヘッダの時刻をどのタイムゾーンとして解釈するか。
 * KIF 形式にはタイムゾーン欄が無いため、アプリ（署名）ごとに補う。
 * - JST: 一般的な将棋アプリ（既定）
 * - UTC: 開始日時を UTC で書き出すアプリ（signature で検出。[detectKifTimezone]）
 */
export type KifTimezone = "JST" | "UTC";

/** KIF ヘッダから抽出した対局メタ */
export interface KifHeader {
  sente: string | null;
  gote: string | null;
  senteDan: number | null;
  goteDan: number | null;
  /** 対局日時（開始日時ヘッダ由来。sourceTz として解釈した絶対時刻） */
  playedAt: Date | null;
  /** playedAt の解釈に用いたタイムゾーン（署名判定の結果） */
  sourceTz: KifTimezone;
  /** 手合割の値（例 "平手"）。ヘッダに無ければ null */
  handicap: string | null;
  /** swars 互換の結果コード（例 "GOTE_WIN_CHECKMATE"）。導出不能・中断は null */
  result: string | null;
}

export interface ParsedKif {
  moves: KifMove[];
  /** パースに失敗した「指し手行」（終局マーカー・ヘッダ・コメントは含めない） */
  errors: { line: number; text: string; reason: string }[];
  header: KifHeader;
}

/** "先手：羽生善治 九段" 等から名前と段位を分離する */
function parsePlayer(value: string): { name: string | null; dan: number | null } {
  const trimmed = value.trim();
  if (!trimmed) return { name: null, dan: null };
  const danMatch = trimmed.match(/[\s　]([一二三四五六七八九])段[\s　]*$/);
  if (danMatch) {
    const dan = KANJI_MAP[danMatch[1]] ?? null;
    const name = trimmed.slice(0, danMatch.index).trim();
    return { name: name || null, dan };
  }
  return { name: trimmed, dan: null };
}

/**
 * 手動貼り付け KIF のうち、開始日時を UTC で書き出すアプリの署名。
 * 実データ観測に基づく指紋（先頭の柿木形式コメント行 ＋ 「持ち時間：」ヘッダ）。
 * これに一致した棋譜のみ開始日時を UTC として解釈する。将来 UTC のアプリが
 * 増えたら、その署名をここに足す（未知アプリは既定の JST 扱い＝従来動作）。
 */
function isUtcSourceKif(kifText: string): boolean {
  return (
    /^\s*#\s*-+\s*KIF形式\s*-+/m.test(kifText) && /^持ち時間[：:]/m.test(kifText)
  );
}

/** KIF テキストから開始日時の解釈タイムゾーンを判定する（既定 JST） */
export function detectKifTimezone(kifText: string): KifTimezone {
  return isUtcSourceKif(kifText) ? "UTC" : "JST";
}

/** "2026/07/15 15:54:18" 等を Date へ（tz として解釈。swars 経路の JST と揃える） */
function parseKifPlayedAt(value: string, tz: KifTimezone): Date | null {
  const m = value
    .trim()
    .match(/(\d{4})\/(\d{1,2})\/(\d{1,2})(?:[\s　]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const pad = (s: string) => s.padStart(2, "0");
  const [, y, mo, d, h = "0", mi = "0", s = "0"] = m;
  const offset = tz === "UTC" ? "+00:00" : "+09:00";
  const offsetMs = (tz === "UTC" ? 0 : 9) * 60 * 60 * 1000;
  const date = new Date(
    `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}${offset}`,
  );
  if (Number.isNaN(date.getTime())) return null;
  // JS が存在しない日時（2026/02/30・25:00 等）を正規化して受理しないよう、
  // 解釈 tz（DST なし）の各成分が入力と一致するか往復検証する
  const local = new Date(date.getTime() + offsetMs);
  const matches =
    local.getUTCFullYear() === Number(y) &&
    local.getUTCMonth() + 1 === Number(mo) &&
    local.getUTCDate() === Number(d) &&
    local.getUTCHours() === Number(h) &&
    local.getUTCMinutes() === Number(mi) &&
    local.getUTCSeconds() === Number(s);
  return matches ? date : null;
}

/**
 * 終局マーカー ＋ 手番 parity から swars 互換の結果コードを導出する。
 * moveNum = 終局マーカーが占める手数。指す側（parity）が敗者になる（勝ち宣言系を除く）。
 */
function deriveResult(moveNum: number, marker: string): string | null {
  if (marker === "中断") return null;
  if (marker === "千日手") return "DRAW_REPETITION";
  // 持将棋（点数互角の膠着）は引き分け。入玉宣言（宣言法）は宣言側の勝ちで別物
  if (marker === "持将棋") return "DRAW_IMPASSE";

  const senteToMove = moveNum % 2 === 1; // 奇数手 = 先手番
  const sideToMove = senteToMove ? "SENTE" : "GOTE";
  const opposite = senteToMove ? "GOTE" : "SENTE";

  // 入玉宣言・反則勝ち は指す側（宣言/主張した側）が勝ち。
  // それ以外（詰み/投了/切れ負け/反則負け）は指す側が負け
  const winner =
    marker === "入玉宣言" || marker === "反則勝ち" ? sideToMove : opposite;
  const reason =
    marker === "詰み"
      ? "CHECKMATE"
      : marker === "投了"
        ? "RESIGN"
        : marker === "切れ負け" || marker === "時間切れ"
          ? "TIMEOUT"
          : marker === "入玉宣言"
            ? "DECLARATION"
            : "ILLEGAL"; // 反則勝ち / 反則負け / 反則
  return `${winner}_WIN_${reason}`;
}

export function parseKif(kifText: string): ParsedKif {
  const lines = kifText.split("\n");
  const moves: KifMove[] = [];
  const errors: ParsedKif["errors"] = [];
  const sourceTz = detectKifTimezone(kifText);
  const header: KifHeader = {
    sente: null,
    gote: null,
    senteDan: null,
    goteDan: null,
    playedAt: null,
    sourceTz,
    handicap: null,
    result: null,
  };

  let prevCol = 0;
  let prevRow = 0;

  // 各マスの成り状態を追跡（"col,row" → boolean）
  // KIF は駒名が成り後の名前になる表記を使うため、
  // USI の "+" を付けるべきかどうかの判定に必要
  const promoted = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // ヘッダ行（対局メタ）の抽出
    const headerMatch = line.match(/^(先手|後手|開始日時|手合割)[：:]\s*(.*)$/);
    if (headerMatch) {
      const [, key, value] = headerMatch;
      if (key === "先手") {
        const { name, dan } = parsePlayer(value);
        header.sente = name;
        header.senteDan = dan;
      } else if (key === "後手") {
        const { name, dan } = parsePlayer(value);
        header.gote = name;
        header.goteDan = dan;
      } else if (key === "開始日時") {
        header.playedAt = parseKifPlayedAt(value, sourceTz);
      } else if (key === "手合割") {
        header.handicap = value.trim() || null;
      }
      continue;
    }

    // 手数で始まらない行はスキップ（見出し、コメント等）
    if (!/^\s*\d+\s/.test(line)) continue;

    // 終局マーカー: result を導出して以降は読まない（末尾の分岐ブロック混入を防ぐ）
    const marker = TERMINAL_MARKERS.find((m) => line.includes(m));
    if (marker) {
      const numMatch = line.match(/^\s*(\d+)/);
      if (numMatch) header.result = deriveResult(Number(numMatch[1]), marker);
      break;
    }

    const m = MOVE_RE.exec(line);
    if (!m) {
      errors.push({ line: i + 1, text: line.trim(), reason: "パース失敗" });
      continue;
    }

    const moveNumber = Number(m[1]);
    const isSame = !!m[2] && m[2].startsWith("同");
    const colStr = m[3]; // 全角数字 (列)
    const rowStr = m[4]; // 漢数字 (段)
    const explicitPromote = m[6] === "成";
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
      // 打った駒は不成
    } else if (fromStr) {
      const fromCol = Number(fromStr[0]);
      const fromRow = Number(fromStr[1]);
      const fromKey = `${fromCol},${fromRow}`;

      // 成り判定:
      // 1. 明示的な「成」サフィックス
      // 2. 駒名が成駒名（馬, 龍, 全 等）かつ移動元が不成 → この手で成った
      const isPromotedPieceName = pieceName in PROMOTED_TO_BASE;
      const wasPromoted = promoted.has(fromKey);
      const promote =
        explicitPromote || (isPromotedPieceName && !wasPromoted);

      usi =
        `${fromCol}${rowToUsi(fromRow)}${destCol}${rowToUsi(destRow)}` +
        (promote ? "+" : "");

      // 成り状態を更新: 移動元をクリア、移動先を設定
      promoted.delete(fromKey);
      const destKey = `${destCol},${destRow}`;
      if (promote || wasPromoted) {
        promoted.add(destKey);
      } else {
        promoted.delete(destKey);
      }
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

  return { moves, errors, header };
}
