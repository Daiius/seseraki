/**
 * 棋譜解析結果から LLM 解説依頼用の Markdown を生成する純関数モジュール。
 *
 * React 非依存・I/O 非依存。将来的に server / commentator パッケージへ
 * 移植できるよう、入出力を独立した型で表現する。
 */

import { turnSymbol } from '../lib/usi';
import {
  DEFAULT_THRESHOLDS,
  computeMoveLosses,
  formatLoss,
  labelOf,
  labelText,
  type MoveLabel,
  type MoveLoss,
  type Thresholds,
} from '../lib/cpl';
import {
  applyMove,
  buildPositions,
  usiToJapaneseWithPiece,
  type BoardState,
  type PieceKind,
} from '../lib/board';

export interface ExportCandidate {
  rank: number;
  move: string;
  scoreType: string;
  scoreValue: number;
  pv: string[] | null;
  depth: number;
}

export interface ExportAnalysis {
  moveNumber: number;
  candidates: ExportCandidate[];
}

export interface KifuExportInput {
  title: string;
  usiMoves: string[];
  sente?: string | null;
  gote?: string | null;
  senteDan?: number | null;
  goteDan?: number | null;
  result?: string | null;
  playedAt?: string | null;
  /** ユーザー視点プロンプトのための識別。null/undefined なら中立視点 */
  userSide?: 'sente' | 'gote' | null;
  /** 悪手判定の閾値。省略時は既定（prd/05-analysis.md §2.5） */
  thresholds?: Thresholds;
  analyses: ExportAnalysis[];
}

/** 段階ラベルが付かないが損失の大きい上位手は「参考」として拾う */
type NotableLabel = 'blunder' | 'dubious' | 'mate' | 'reference';

interface NotablePosition {
  moveNumber: number;
  /**
   * 先手視点の局面評価値（表示用の文字列）。**mate は `±M11` のまま出す**
   * ——`toSenteEval` の ±3000 クランプを通すと詰み手数が消え、cp の 3000 と区別できなくなる。
   * 実手後の局面が未解析なら scoreAfter は null。
   */
  scoreBefore: string;
  scoreAfter: string | null;
  loss: MoveLoss;
  label: NotableLabel;
}

const DEFAULT_TOP_N = 5;

const HAND_ORDER: PieceKind[] = ['R', 'B', 'G', 'S', 'N', 'L', 'P'];
const HAND_NAME: Record<string, string> = {
  P: '歩', L: '香', N: '桂', S: '銀', G: '金', B: '角', R: '飛',
};

/**
 * 駒名付き日本語表記を返す。state が無い場合は USI のまま返す。
 * 移動元の (37) のような数字併記は、複数の同種駒が同じマスに動ける曖昧局面で
 * 正確な手の把握に必要なため意図的に残している。
 */
function moveJp(state: BoardState | undefined, usi: string): string {
  if (!state) return usi;
  return usiToJapaneseWithPiece(state, usi);
}

function formatScoreCompact(
  scoreType: string,
  scoreValue: number,
  moveNumber: number,
): string {
  const v = moveNumber % 2 === 1 ? -scoreValue : scoreValue;
  if (scoreType === 'mate') {
    if (v > 0) return `+M${v}`;
    if (v < 0) return `-M${-v}`;
    return '詰み';
  }
  return v >= 0 ? `+${v}` : `${v}`;
}

function formatHand(side: Partial<Record<PieceKind, number>>): string {
  const parts: string[] = [];
  for (const kind of HAND_ORDER) {
    const n = side[kind];
    if (!n) continue;
    parts.push(n > 1 ? `${HAND_NAME[kind]}${n}` : HAND_NAME[kind]);
  }
  return parts.length > 0 ? parts.join(' ') : 'なし';
}

/** swars 結果コードを日本語化（SENTE_WIN_CHECKMATE → 「先手の詰み勝ち」など） */
function formatResult(code: string | null | undefined): string | null {
  if (!code) return null;
  if (code.includes('DRAW')) {
    if (code.includes('REPETITION')) return '千日手';
    if (code.includes('IMPASSE')) return '入玉宣言（持将棋）';
    return '引き分け';
  }
  const winner = code.startsWith('SENTE_WIN_')
    ? '先手の'
    : code.startsWith('GOTE_WIN_')
      ? '後手の'
      : null;
  if (!winner) return code;
  const reason = code.includes('CHECKMATE')
    ? '詰み勝ち'
    : code.includes('RESIGN')
      ? '投了勝ち'
      : code.includes('TIMEOUT')
        ? '時間切れ勝ち'
        : code.includes('ILLEGAL')
          ? '反則勝ち'
          : code.includes('DECLARATION')
            ? '入玉宣言勝ち'
            : '勝ち';
  return `${winner}${reason}`;
}

/**
 * 注目局面を CPL で選ぶ（prd/06-llm-commentary.md §2.1）。
 * **悪手と詰み系は全部**拾い、残りを損失の大きい順に topN まで埋める。
 * **疑問手を全部入れると 1 局で数十節に膨らむ**ため、疑問手は評価値推移表の備考だけに出す。
 */
function selectNotablePositions(
  analyses: ExportAnalysis[],
  losses: Map<number, MoveLoss>,
  thresholds: Thresholds,
  topN = DEFAULT_TOP_N,
): NotablePosition[] {
  const byMoveNumber = new Map(analyses.map((a) => [a.moveNumber, a]));

  const entries: NotablePosition[] = [];
  for (const loss of losses.values()) {
    // 勝負が決した局面のぬるい手は注目から外す（詰み系は cp の量ではないので対象外）。
    // 判定側と同じ基準に揃えてあり、グラフのマーカーと食い違わない
    if (!loss.mate && loss.bestCp !== null && Math.abs(loss.bestCp) >= thresholds.decided) {
      continue;
    }

    const currBest = byMoveNumber.get(loss.moveNumber)?.candidates.find((c) => c.rank === 1);
    if (!currBest) continue;
    const nextBest = byMoveNumber
      .get(loss.moveNumber + 1)
      ?.candidates.find((c) => c.rank === 1);

    entries.push({
      moveNumber: loss.moveNumber,
      scoreBefore: formatScoreCompact(currBest.scoreType, currBest.scoreValue, loss.moveNumber),
      scoreAfter: nextBest
        ? formatScoreCompact(nextBest.scoreType, nextBest.scoreValue, loss.moveNumber + 1)
        : null,
      loss,
      label: labelOf(loss, thresholds) ?? 'reference',
    });
  }

  const labeled = entries.filter((e) => e.label === 'blunder' || e.label === 'mate');
  // 補完の対象からも疑問手を外す。ここに残すと「疑問手は備考のみ」が損失上位の疑問手だけ破れる
  const topByLoss = [...entries]
    .filter((e) => e.loss.loss !== null && e.label !== 'dubious')
    .sort((a, b) => b.loss.loss! - a.loss.loss!)
    .slice(0, topN);

  const seen = new Set<number>();
  const merged: NotablePosition[] = [];
  for (const e of [...labeled, ...topByLoss]) {
    if (seen.has(e.moveNumber)) continue;
    seen.add(e.moveNumber);
    merged.push(e);
  }
  merged.sort((a, b) => a.moveNumber - b.moveNumber);
  return merged;
}

/**
 * 評価値推移表の備考欄。段階ラベルが無ければ空文字。
 * **注目局面に選ばれたかではなく、その手の判定そのもの**を出す（疑問手はここにだけ出る）。
 */
function moveNote(loss: MoveLoss, label: MoveLabel): string {
  if (label === 'mate') return `×${labelText(loss, 'mate') ?? '詰み系'}`;
  // 近似（実手が候補外）は注目局面の見出しと同じく ≈ を添える
  const lossStr = `${loss.approximate ? '≈' : ''}${loss.loss}cp 損`;
  if (label === 'blunder') return `⚠悪手（${lossStr}）`;
  if (label === 'dubious') return `?疑問手（${lossStr}）`;
  return '';
}

function formatPlayedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatPv(pv: string[], startMoveNumber: number, startState: BoardState): string {
  const parts: string[] = [];
  let state = startState;
  for (let j = 0; j < pv.length; j++) {
    const turn = turnSymbol(startMoveNumber + j);
    parts.push(`${turn}${moveJp(state, pv[j])}`);
    state = applyMove(state, pv[j]);
  }
  return parts.join(' ');
}

export function generateKifuMarkdown(input: KifuExportInput): string {
  const lines: string[] = [];
  const positions = buildPositions(input.usiMoves);
  const sortedAnalyses = [...input.analyses].sort((a, b) => a.moveNumber - b.moveNumber);
  const thresholds = input.thresholds ?? DEFAULT_THRESHOLDS;
  const analyzed = sortedAnalyses.filter((a) => a.candidates.length > 0);
  const losses = computeMoveLosses(analyzed, input.usiMoves);
  const notable = selectNotablePositions(analyzed, losses, thresholds);

  // 依頼プロンプト
  const userName =
    input.userSide === 'sente'
      ? input.sente
      : input.userSide === 'gote'
        ? input.gote
        : null;
  const opponentName =
    input.userSide === 'sente'
      ? input.gote
      : input.userSide === 'gote'
        ? input.sente
        : null;

  lines.push(opponentName ? `# 棋譜解析 vs ${opponentName}` : '# 棋譜解析');
  lines.push('');

  if (input.userSide === 'sente' || input.userSide === 'gote') {
    const userSideLabel = input.userSide === 'sente' ? '先手' : '後手';
    const userDisplay = userName ?? userSideLabel;
    const senteDisplay = input.sente ?? '先手';
    const goteDisplay = input.gote ?? '後手';
    lines.push(
      `以下は先手・${senteDisplay}、後手・${goteDisplay}の対局です。次を含めて解説してください（改善点は${userDisplay}側に絞って構いません）。`,
    );
    lines.push('');
    lines.push('- 戦型・序盤の構想');
    lines.push('- 対局の流れと攻防の要点');
    lines.push('- ターニングポイントとなった手（悪手・疑問手）と、その代替案・意図');
    lines.push(`- 全体総評（${userDisplay}が次に活かす改善点）`);
  } else {
    lines.push('以下の棋譜と解析結果を踏まえ、次を含む形で解説してください。');
    lines.push('- 戦型・序盤の構想');
    lines.push('- 対局の流れと攻防の要点');
    lines.push('- ターニングポイントとなった手（特に悪手）と、その代替案・意図');
    lines.push('- 全体総評（次に向けた改善点）');
  }
  lines.push('');

  // 対局情報
  lines.push('## 対局情報');
  lines.push('');
  if (input.title) lines.push(`- タイトル: ${input.title}`);
  if (input.sente) {
    const dan = input.senteDan ? `（${input.senteDan}段）` : '';
    lines.push(`- 先手: ${input.sente}${dan}`);
  }
  if (input.gote) {
    const dan = input.goteDan ? `（${input.goteDan}段）` : '';
    lines.push(`- 後手: ${input.gote}${dan}`);
  }
  const resultJp = formatResult(input.result);
  if (resultJp) lines.push(`- 結果: ${resultJp}`);
  if (input.playedAt) lines.push(`- 対局日時: ${formatPlayedAt(input.playedAt)}`);
  lines.push('');

  // 評価値推移
  lines.push(
    '## 評価値推移（先手視点 cp、正＝先手有利。⚠＝悪手、?＝疑問手、×＝詰み系。'
      + `損失＝最善手の評価 − 実手の評価。悪手 ${thresholds.blunder}cp / 疑問手 ${thresholds.dubious}cp 以上）`,
  );
  lines.push('');
  lines.push('| 手数 | 指し手 | 評価値 | 備考 |');
  lines.push('|---:|---|---:|---|');
  for (const a of sortedAnalyses) {
    if (a.moveNumber === 0) continue;
    const idx = a.moveNumber - 1;
    const played = input.usiMoves[idx];
    if (!played) continue;
    const preState = positions[idx];
    const turn = turnSymbol(idx);
    const moveStr = `${turn}${moveJp(preState, played)}`;
    const best = a.candidates.find((c) => c.rank === 1);
    const evalStr = best
      ? formatScoreCompact(best.scoreType, best.scoreValue, a.moveNumber)
      : '-';
    const loss = losses.get(idx);
    const note = loss ? moveNote(loss, labelOf(loss, thresholds)) : '';
    lines.push(`| ${a.moveNumber} | ${moveStr} | ${evalStr} | ${note} |`);
  }
  lines.push('');

  // 注目局面
  if (notable.length > 0) {
    lines.push('## 注目局面');
    lines.push('');
    for (const n of notable) {
      const idx = n.moveNumber;
      const played = input.usiMoves[idx];
      if (!played) continue;
      const preState = positions[idx];
      const turn = turnSymbol(idx);
      const playedJp = moveJp(preState, played);

      const label = n.label === 'reference' ? '参考' : labelText(n.loss, n.label) ?? '参考';
      const lossStr = formatLoss(n.loss);
      const evalStr = `評価値 ${n.scoreBefore} → ${n.scoreAfter ?? '（未解析）'}`;
      const parts = [label, ...(lossStr ? [lossStr] : []), evalStr];

      lines.push(`### ${idx + 1} 手目 ${turn}${playedJp}（${parts.join('、')}）`);
      lines.push('');

      if (preState) {
        lines.push(
          `- 持ち駒: 先手 ${formatHand(preState.hand.sente)} / 後手 ${formatHand(preState.hand.gote)}`,
        );
      }

      const analysisBefore = sortedAnalyses.find((a) => a.moveNumber === idx);
      if (analysisBefore) {
        const playedCand = analysisBefore.candidates.find((c) => c.move === played);
        if (playedCand) {
          const scoreStr = formatScoreCompact(playedCand.scoreType, playedCand.scoreValue, idx);
          lines.push(
            `- **実手 ${turn}${playedJp}**: ${scoreStr}（rank ${playedCand.rank}、d${playedCand.depth}）`,
          );
        } else {
          lines.push(`- **実手 ${turn}${playedJp}**: 候補手リスト外`);
        }

        const recommended = analysisBefore.candidates.filter((c) => c.move !== played);
        for (const c of recommended) {
          const cJp = moveJp(preState, c.move);
          const scoreStr = formatScoreCompact(c.scoreType, c.scoreValue, idx);
          lines.push(`- **推奨${c.rank} ${turn}${cJp}**: ${scoreStr}（d${c.depth}）`);
          if (c.pv && c.pv.length > 0 && preState) {
            lines.push(`  - 読み筋: ${formatPv(c.pv, idx, preState)}`);
          }
        }
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}
