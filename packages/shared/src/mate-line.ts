/**
 * `score mate N` の読み筋を分類する（設計 Phase A）。
 *
 * USI の `score mate N` は「詰みまでの手数（plies）」で、**受方の応手・逆王手・合駒が全部入る**。
 * 詰将棋の「N手詰」（初手から王手の連続・無駄合いは数えない）とは意味が違うので、
 * そのまま「N手詰」と表示すると読み手を誤らせる。
 *
 * ただし `candidate_moves.pv` が保存されているので、**読み筋を盤面追跡で辿れば
 * 「初手が王手か」「攻方の手が全て王手か」は表示時に判る**。追加の探索も DB 変更も要らない。
 * ここはその判定だけを行う純関数で、`scoreValue`（エンジンの距離）には触れない。
 *
 * ⚠ **環境非依存**（`lib: esnext` / `types: []`）。DOM / node の API を使わない。
 */
import { applyMove, type BoardState, type Side } from './board';
import { isAttackedBy } from './position-validation';

/**
 * 分類の種類。
 *
 * 🔴 **「受けが無い」を担保しているのは pv ではなく mate スコアの方**（レビュー `OCL-72421091` への反証）。
 * engine が `mate N` を返した時点で「**受方がどう応じても N 手以内に詰む**」ことは読み切られている
 * （受方は最長になる応手を選ぶので、pv の受方の手は最善の粘り）。`classifyMateLine` が pv から
 * 取り出しているのは**攻方の手が王手だったかどうか**という一点だけで、受けの全数検証は
 * mate スコアが済ませている。
 *
 * ⚠ ただし**攻方の手の側は pv 1 本の観測**にすぎない。他の受け方に対する攻方の手は pv に現れないので、
 * 「攻方の手が全て王手」は**この読み筋上での事実**であって、あらゆる変化で王手の連続になる保証ではない
 * （下記 `checkmate` の但し書き）。
 *
 * ⚠ **深さ不足による false negative は許容する**（読み切れず mate が出なければ分類の対象にすらならない）。
 * 「取りこぼし」（prd/09 §3.1）と同じ性質で、出た分だけが正しいという方向に倒してある。
 *
 * ⚠ **「必至」が保証するのは受けが無いことだけで、いま詰めろが掛かっていることではない**
 * （レビュー `OCL-91BC8098` への回答。詳細は prd/05 §2.2）。攻方が王手されている局面では、
 * 攻方はまず王手を外す必要があるためその瞬間に詰めろは掛かっていないが、受けが無いことは
 * 変わらないので本サービスでは「必至」と表示する。手番を相手に渡しても詰むかの検証（本当の
 * 詰めろ判定）は未実装。
 */
export type MateLineKind =
  /**
   * **pv 上で**攻方の手が全て王手だった、という観測事実（詰将棋の「詰み」と同じ形）。
   * ⚠ **pv に現れない受け方まで検証したものではない**——他の応手では静かな手が混ざりうる。
   * ⚠ 手数（`plies`）は engine の距離のままで、**合駒を含む**（`interposes`）。
   */
  | 'checkmate'
  /**
   * 初手だけ静かな手で、以降の攻方の手は全て王手（必至を掛ける手 / 受けなしの局面）。
   * 「受けが無い」は mate スコアが担保しているので、**静かな手で受けなしにした ＝ 必至**と言える。
   *
   * 🔒 **表示は `forced` と同じ「必至」**（prd/05 §2.2）。「受けが無い」ことは mate スコアが
   * 保証しており、**読み筋の形は条件ではない**ので、表示で両者を分ける理由が無い。
   * ただし **`matedSideInCheck === true`（詰まされる側が王手中）なら必至とは呼ばない**（`MateLine` 参照）。
   *
   * 🔒 **分類の区別は残す**——手番を反転して探索する判定を将来入れたとき、
   * 「詰めろ」を正しく名乗り分ける余地にする。
   */
  | 'hisshi'
  /**
   * 途中に静かな手を挟む（2手すき以上が受からない形・玉の早逃げが混ざる形など）。
   *
   * 🔒 **表示は `hisshi` と同じ「必至」**（王手中を除く。prd/05 §2.2）。手順の形が違うだけで、
   * 「相手がどう応じても詰む」という内容は mate スコアの側が保証している。
   */
  | 'forced'
  /**
   * **手番側の玉が王手されていて、engine が指す手を持たない**（pv が `resign`・`mateValue < 0`）。
   *
   * ⚠ **詰みの証明ではない。** 「合法手が無い」ことの検証には合法手生成が要り、それは作らないと
   * 決めてある（prd/12 §2.5）。ここが根拠にするのは**盤面から確かめられる範囲の観測事実**——
   * 「王手されている」＋「engine が指す手を持たない」の 2 つだけ。
   *
   * 🔒 **`win`（入玉宣言勝ち）は含めない。** 手番側が**勝つ**手なので意味が正反対。
   * 🔒 **王手されていない `resign`（見切り投了）は `unknown` に落とす。**
   * 🔒 **`unknown`（読めない指し手）と混ぜない。** 混ぜると「本当に pv が壊れている」場合と
   * 区別が付かず、終局局面が `1手で詰` のように表示される（実際に踏んだ。kifu 1 の 106 手目）。
   */
  | 'gameover'
  /** pv が無い / mate 距離より短い / 盤面が追えない */
  | 'unknown';

export interface MateLine {
  kind: MateLineKind;
  /** `|mateValue|`（エンジンの詰み距離・plies） */
  plies: number;
  /**
   * 攻方の王手の数。**pv に現れる攻方の手だけ**を数える
   * （`mateValue < 0` のとき「現局面が既に王手」であることは分類には使うが、ここには入れない）。
   */
  checks: number;
  /** 受方の合駒（王手中に打って直後に取られた手）の数。無駄合いの近似（設計 §1.4） */
  interposes: number;
  /**
   * 🔴 **現局面で「詰まされる側」の玉が王手されているか**（表示語の選択に使う。レビュー `OCL-2C1FDEAD`）。
   *
   * 詰まされる側（受方）は **mate の符号で決まる**——`mateValue > 0` なら手番側の相手、
   * `mateValue < 0` なら手番側自身。**手番側ではない**。
   *
   * 🔴 **必至は「詰まされる側に王手が掛かっていない」局面にだけ使う。** 「受けが無い」ことは
   * **mate スコアが保証している**（相手が最善に応じても詰む、という読み切り）ので、**読み筋の形は
   * 必至の条件ではない**。語が不適切になるのは**詰まされる側が王手中**のときだけ——そこは
   * 詰めろの段階ではなく、既に詰まし合いの最中。
   * ⚠ **勝つ側（攻方）が王手されていることは必至かどうかと関係が無い。** 実際に踏んだ:
   * 手番側を見る実装（#114）は、手番側が攻方のときに**勝つ側の王手**を理由に必至を取り下げ、
   * 必至である局面を `△5手で詰` と表示していた（kifu1 #103）。
   *
   * ⚠ **分類（`kind`）だけでは弾けない。** 王手されている側が**玉を逃げる手**は王手ではないので、
   * 形の上では `hisshi` にも `forced` にもなりうる。表示側は `hisshi` / `forced` **かつ**
   * この値が `false` のときだけ「必至」を出す（prd/05 §2.2）。
   * 🔒 `checkmate` はこの除外の対象外。王手を解除しながら王手を掛ける手から詰ますことはあり、
   * それは正真正銘の即詰みなので `N手詰` のままでよい。
   *
   * ⚠ **現状のデータでは、この除外は発火しない。** dev DB の rank1 mate 行 14 件を突き合わせた
   * ところ、**詰まされる側が王手されている行は例外なく `checkmate` か `gameover`** で、
   * `hisshi` / `forced` には現れなかった（実質は「mate が出ていれば必至」）。
   * 🔒 **それでも規則として残す**——将来のデータや手番反転探索で発火しうるし、
   * 「王手中を必至と呼ばない」こと自体は正しいから。
   *
   * ⚠ 玉が盤上に無い（盤面が追えない）ときは `false`。その場合は分類自体が `unknown` に落ちる。
   */
  matedSideInCheck: boolean;
}

/** USI の指し手の書式（移動 `7g7f` / 成り `7g7f+` / 打ち `P*5e`） */
const USI_MOVE = /^(?:[1-9][a-i][1-9][a-i]\+?|[PLNSGBR]\*[1-9][a-i])$/;

/**
 * 投了（`bestmove resign`）。**指し手ではない**ので盤面には適用できない。
 *
 * 🔒 **`win`（入玉宣言勝ち）は含めない。** `win` は**手番側が勝つ**手で意味が正反対であり、
 * 「手番側が詰まされている」の根拠にならない（レビュー `OCL-DA238CEA`）。
 * dev DB の実データでも `win` を含む pv は 1 件も無い。
 */
const RESIGN = 'resign';

/** USI 座標（例 `7g`）→ `[row, col]`。盤の内部表現は `board.ts` と同じ向き */
function usiToIndex(usi: string): [row: number, col: number] {
  return [usi.charCodeAt(1) - 97, 9 - Number(usi[0])];
}

/** 指し手の移動先（打ちも移動も受ける。`7g7f+` の `+` は落としてから読む） */
function destination(move: string): [row: number, col: number] {
  const square = move.endsWith('+') ? move.slice(-3, -1) : move.slice(-2);
  return usiToIndex(square);
}

function opponentOf(side: Side): Side {
  return side === 'sente' ? 'gote' : 'sente';
}

function findKing(state: BoardState, side: Side): [row: number, col: number] | null {
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      const piece = state.board[row][col];
      if (piece && piece.side === side && piece.kind === 'K') return [row, col];
    }
  }
  return null;
}

/** 受方の玉が攻方に王手されているか。玉が盤上に無ければ `null`（＝追えない） */
function isChecked(state: BoardState, defender: Side, attacker: Side): boolean | null {
  const king = findKing(state, defender);
  if (!king) return null;
  return isAttackedBy(state, attacker, king[0], king[1]);
}

/**
 * 読み筋を辿って詰み筋の形を分類する。
 *
 * @param state pv を指す前の局面（`scoreValue` を出したときの局面）
 * @param pv    読み筋（USI）。`|mateValue|` 手より長くてよい（先頭だけを見る）
 * @param mateValue エンジンの `score mate N`（**手番側から見た値**。負なら手番側が詰まされる）
 */
export function classifyMateLine(
  state: BoardState,
  pv: readonly string[],
  mateValue: number,
): MateLine {
  const plies = Math.abs(mateValue);
  let checks = 0;
  let interposes = 0;

  // 符号が読めない / 距離 0 では攻方・受方が決まらないので、王手判定より先に落とす
  if (!Number.isInteger(mateValue) || plies === 0) {
    return { kind: 'unknown', plies, checks: 0, interposes: 0, matedSideInCheck: false };
  }

  const attacker: Side = mateValue > 0 ? state.sideToMove : opponentOf(state.sideToMove);
  const defender = opponentOf(attacker);

  /*
    🔴 **「受方（＝詰まされる側）の玉が王手されているか」は 1 回だけ求めて 2 用途で共有する。**
    かつては分類用（`mateValue < 0` のとき「直前の攻方の手が王手だったか」）と表示用が
    別々に立っていたが、表示用を正しい側——手番側ではなく**詰まされる側**——に直した結果、
    **両者は同じ盤面・同じ玉を見る同一の判定**になった（`mateValue < 0` なら受方＝手番側で、
    以前から同じものだった）。別名で 2 回書くと「視点が違うのだろう」と読ませてしまうので統合する。

    用途が違うことは残っている: 分類は `null`（玉が盤上に無い ＝ 追えない）を `unknown` の
    根拠に使い、表示は `null` を `false` に潰す。**その差だけを生の値と真偽値の 2 変数で表す。**
  */
  const matedInCheck = isChecked(state, defender, attacker);
  const matedSideInCheck = matedInCheck === true;
  const unknown = (): MateLine => ({
    kind: 'unknown',
    plies,
    checks,
    interposes,
    matedSideInCheck,
  });

  /*
    🔴 **投了（`resign`）は 3 条件を全て満たすときだけ `gameover`**（レビュー `OCL-DA238CEA`）。
    `resign` は「engine が指す手を持たない」ことの表明でしかなく、それ単体では盤面の状態を証明しない。

    1. `pv[0] === 'resign'`（`win` = 入玉宣言勝ちは意味が正反対なので外す）
    2. `mateValue < 0`（手番側が負けている ＝ 投了するのは手番側）
    3. **手番側の玉が王手されている**（盤面から確かめられる。`mateValue < 0` なので
       手番側＝受方であり、`matedInCheck` がそのまま「手番側の玉が王手されているか」になる）

    ⚠ **判定は手数の検査より先**。`resign` は指し手ではないので `pv.length` を mate 距離と
    比べても意味がない（`mate -1` は通り抜けるが `mate -5` は通り抜けない、という差が出てしまう）。
  */
  if (pv.length > 0 && pv[0] === RESIGN) {
    if (mateValue < 0 && matedInCheck === true) {
      return { kind: 'gameover', plies, checks: 0, interposes: 0, matedSideInCheck };
    }
    // 王手されていないのに投了した（見切り投了）/ 手番側が勝っている pv は根拠にならない
    return unknown();
  }

  // PV は延長されうるが完全とは限らない。短い PV で `checkmate` と言い切らない
  if (pv.length < plies) return unknown();

  // 攻方の手が王手だったか（先頭から順）。`mateValue < 0` のとき pv の初手は受方の手なので、
  // 「現局面で受方玉が王手されているか」＝直前の攻方の手が王手だったか、を先頭に置く
  const attackerChecks: boolean[] = [];
  if (mateValue < 0) {
    if (matedInCheck === null) return unknown();
    attackerChecks.push(matedInCheck);
  }

  // 受方が王手中に打った駒のマス（直後に攻方が取れば合駒とみなす）
  let interposed: [number, number] | null = null;
  let current = state;

  for (const move of pv.slice(0, plies)) {
    if (!USI_MOVE.test(move)) return unknown();
    const mover = current.sideToMove;
    if (!move.includes('*')) {
      // applyMove は不正な手を黙って読み飛ばすので、ここで追えないことを検出する
      const [fromRow, fromCol] = usiToIndex(move.slice(0, 2));
      const piece = current.board[fromRow][fromCol];
      if (!piece || piece.side !== mover) return unknown();
    }
    const [toRow, toCol] = destination(move);
    const next = applyMove(current, move);

    if (mover === attacker) {
      const inCheck = isChecked(next, defender, attacker);
      if (inCheck === null) return unknown();
      attackerChecks.push(inCheck);
      if (inCheck) checks++;
      if (interposed && interposed[0] === toRow && interposed[1] === toCol) interposes++;
      interposed = null;
    } else {
      const wasCheck = attackerChecks.length > 0 && attackerChecks[attackerChecks.length - 1];
      interposed = wasCheck && move.includes('*') ? [toRow, toCol] : null;
    }
    current = next;
  }

  if (attackerChecks.length === 0) return unknown();
  if (attackerChecks.every(Boolean)) {
    return { kind: 'checkmate', plies, checks, interposes, matedSideInCheck };
  }
  if (!attackerChecks[0] && attackerChecks.slice(1).every(Boolean)) {
    return { kind: 'hisshi', plies, checks, interposes, matedSideInCheck };
  }
  return { kind: 'forced', plies, checks, interposes, matedSideInCheck };
}
