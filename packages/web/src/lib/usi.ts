import { classifyMateLine, type BoardState, type MateLine } from 'shared';

/**
 * 表示に使う mate 分類を作る。mate 以外・盤面や pv が無いときは `undefined`
 * （＝分類不明として「N手で詰み」の既定表記になる）。
 *
 * `state` は**その評価値を出した局面**、`scoreValue` は**その局面の手番側から見た値**
 * （保存値そのまま）でなければならない。ずれると攻方を取り違える。
 */
export function mateLineOf(
  state: BoardState | undefined | null,
  scoreType: string,
  scoreValue: number,
  pv: string[] | undefined | null,
): MateLine | undefined {
  if (scoreType !== 'mate' || !state || !pv || pv.length === 0) return undefined;
  return classifyMateLine(state, pv, scoreValue);
}

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
 * mate の括弧内（広い形）。
 *
 * 🔴 **`score mate N` は「詰みまでの手数（plies）」**で、受方の応手・逆王手・合駒が全部入る。
 * 日本語の「N手詰」（詰将棋 = 初手から王手の連続）とは意味が違うので、**既定は「N手で詰み」**とし、
 * 読み筋を辿って攻方の手が全て王手だと判った（`checkmate`）ときだけ「N手詰」を名乗る。
 */
function mateWording(plies: number, line?: MateLine): string {
  // 投了局面（手番側が王手されていて engine が指す手を持たない）。手数は意味を持たないので出さない
  if (line?.kind === 'gameover') return '詰み';
  if (line?.kind === 'checkmate') {
    // 合駒で手数が伸びていることは「N手詰」を名乗るときだけ添える（設計 §1.4）。
    // 「N手で詰み」は元々詰将棋の手数を騙っていないので、添えても情報が増えない
    const interposes = line.interposes > 0 ? `・合駒${line.interposes}` : '';
    return `${plies}手詰${interposes}`;
  }
  if (isHisshi(line)) return `必至・${plies}手で詰み`;
  return `${plies}手で詰み`;
}

/**
 * 「必至」を名乗ってよいか。
 *
 * 🔴 **「受けが無い」ことは mate スコアそのものが保証している**（相手が最善に応じても詰む、という
 * 読み切り）。読み筋の**形**（初手が静かか、途中に静かな手が混ざるか）は受けの有無とは関係が無いので、
 * `hisshi` と `forced` を分ける理由が表示には無い。
 *
 * 🔴 **必至という語が不適切になるのは「いま王手が掛かっている」ときだけ**（レビュー `OCL-2C1FDEAD`・
 * prd/05 §2.2）。必至は「**受けられない詰めろ**が掛かっている」状態を指す語で、王手中は詰めろの
 * 段階ではなく既に詰まし合いの最中だから。⚠ 分類だけでは弾けない——**王手されている側が玉を
 * 逃げる手は王手ではない**ので、形の上では `hisshi` にも `forced` にもなりうる。
 *
 * 🔒 **`unknown` は含めない。** 形を追えなかった以上、**盤面の状態そのものを信用しきれない**
 * （pv が読めない・mate 距離より短いケースを含む）。王手判定が正しく効いている保証も無い。
 *
 * 🔒 **`checkmate` にこの除外は掛けない**（呼び出し側で先に返している）。王手を解除しながら
 * 王手を掛ける手から詰ますことはあり、それは正真正銘の即詰みで `N手詰` のままが正しい。
 */
function isHisshi(line?: MateLine): boolean {
  return (line?.kind === 'hisshi' || line?.kind === 'forced') && !line.sideToMoveInCheck;
}

/** mate の短い形（情報行）。勝者の記号は呼び出し側が前置する */
function mateWordingShort(plies: number, line?: MateLine): string {
  if (line?.kind === 'gameover') return '詰み';
  if (line?.kind === 'checkmate') return `${plies}手詰`;
  // 🔒 手数は括弧で括る（決定 2026-08-29・実機で確認）。`▲必至9` は
  //    「必至9」が 1 語に見えて手数が読み取りにくかった。`手詰` は語尾が
  //    数の終わりを示すのでそのまま
  if (isHisshi(line)) return `必至(${plies})`;
  // 🔒 必至を名乗れない場合（王手中 / `unknown` / pv なし）は語を強めない。
  //    ただし `詰(N)` は「詰んでいる」と読めてしまうため綴りを変える。`N手で詰` なら
  //    広い形の `N手で詰み` と同じ読み下しになり、数は `手` で終わるので括弧も要らない
  return `${plies}手で詰`;
}

/**
 * **先手視点に直したあとの値**を読みやすい文字列にする。
 * 視点をどう作るかは呼び出し側の責務（棋譜は手数の parity・検討盤は手番）。
 *
 * `line` は読み筋の分類（`classifyMateLine`）。省略すると mate は「N手で詰み」になる。
 */
function describeSenteScore(scoreType: string, senteValue: number, line?: MateLine): string {
  if (scoreType === 'mate') {
    // 🔒 `gameover`（pv が `resign`）は手数を出さず `詰み` にするが、**勝者は落とさない**
    //    （`mate` の符号から判るため。§2.1）。勝者不明の `詰み` は `mate 0` の側だけ
    if (senteValue > 0) return `先手勝ち(${mateWording(senteValue, line)})`;
    if (senteValue < 0) return `後手勝ち(${mateWording(-senteValue, line)})`;
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
  line?: MateLine,
): string {
  // 後手番（奇数手目）のスコアは反転して先手視点にする
  return describeSenteScore(scoreType, moveNumber % 2 === 1 ? -scoreValue : scoreValue, line);
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
  line?: MateLine,
): string {
  return describeSenteScore(
    scoreType,
    sideToMove === 'gote' ? -scoreValue : scoreValue,
    line,
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
  line?: MateLine,
): string {
  // 後手番（奇数手目）のスコアは反転して先手視点にする（`formatScore` と同じ）
  const senteValue = moveNumber % 2 === 1 ? -scoreValue : scoreValue;

  if (scoreType === 'mate') {
    // ▲ / △ は「詰ます側」。0 手詰（既に詰んでいる）と値が壊れている場合は
    // `formatScore` と同じく勝者を名乗らない
    if (senteValue > 0) return `▲${mateWordingShort(senteValue, line)}`;
    if (senteValue < 0) return `△${mateWordingShort(-senteValue, line)}`;
    return '詰み';
  }

  const sign = senteValue > 0 ? '+' : '';
  return `${sign}${senteValue}`;
}
