/**
 * 棋譜解析結果から LLM 解説依頼用の Markdown を生成する純関数モジュール。
 *
 * React 非依存・I/O 非依存。将来的に server / commentator パッケージへ
 * 移植できるよう、入出力を独立した型で表現する。
 */

import { detectBlunders, toSenteEval, turnSymbol } from '../lib/usi';
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
  analyses: ExportAnalysis[];
}

type NotableLabel = 'blunder' | 'good' | 'reference';

interface NotablePosition {
  moveNumber: number;
  scoreBefore: number;
  scoreAfter: number;
  delta: number;
  label: NotableLabel;
}

const DEFAULT_TOP_N = 5;
const LABEL_DELTA_THRESHOLD = 150;
/** scoreBefore がこれ以上の絶対値なら勝負が決した局面とみなし、注目局面から除外 */
const DECIDED_THRESHOLD = 1000;

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

function formatSente(value: number): string {
  return value >= 0 ? `+${value}` : `${value}`;
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
          : '勝ち';
  return `${winner}${reason}`;
}

function selectNotablePositions(
  analyses: ExportAnalysis[],
  usiMoves: string[],
  topN = DEFAULT_TOP_N,
): NotablePosition[] {
  const sorted = [...analyses]
    .filter((a) => a.candidates.length > 0)
    .sort((a, b) => a.moveNumber - b.moveNumber);
  const blunders = detectBlunders(sorted, usiMoves);

  type Entry = {
    moveNumber: number;
    scoreBefore: number;
    scoreAfter: number;
    delta: number;
    absDelta: number;
    isBlunder: boolean;
  };

  const entries: Entry[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const curr = sorted[i];
    const next = sorted[i + 1];
    if (next.moveNumber !== curr.moveNumber + 1) continue;

    const currBest = curr.candidates.find((c) => c.rank === 1);
    const nextBest = next.candidates.find((c) => c.rank === 1);
    if (!currBest || !nextBest) continue;

    const scoreBefore = toSenteEval(currBest.scoreType, currBest.scoreValue, curr.moveNumber);
    const scoreAfter = toSenteEval(nextBest.scoreType, nextBest.scoreValue, next.moveNumber);

    // 勝負が決した局面以降の悪手・好手は注目局面から除外
    if (Math.abs(scoreBefore) >= DECIDED_THRESHOLD) continue;

    const isSenteTurn = curr.moveNumber % 2 === 0;
    const delta = isSenteTurn ? scoreAfter - scoreBefore : scoreBefore - scoreAfter;

    entries.push({
      moveNumber: curr.moveNumber,
      scoreBefore,
      scoreAfter,
      delta,
      absDelta: Math.abs(delta),
      isBlunder: blunders.has(curr.moveNumber),
    });
  }

  const topByDelta = [...entries]
    .sort((a, b) => b.absDelta - a.absDelta)
    .slice(0, topN);
  const blunderEntries = entries.filter((e) => e.isBlunder);

  const seen = new Set<number>();
  const merged: Entry[] = [];
  for (const e of [...topByDelta, ...blunderEntries]) {
    if (seen.has(e.moveNumber)) continue;
    seen.add(e.moveNumber);
    merged.push(e);
  }
  merged.sort((a, b) => a.moveNumber - b.moveNumber);

  return merged.map((e) => {
    let label: NotableLabel;
    if (e.isBlunder) {
      label = 'blunder';
    } else if (e.absDelta >= LABEL_DELTA_THRESHOLD) {
      label = e.delta < 0 ? 'blunder' : 'good';
    } else {
      label = 'reference';
    }
    return {
      moveNumber: e.moveNumber,
      scoreBefore: e.scoreBefore,
      scoreAfter: e.scoreAfter,
      delta: e.delta,
      label,
    };
  });
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
  const notable = selectNotablePositions(sortedAnalyses, input.usiMoves);
  const notableMap = new Map(notable.map((n) => [n.moveNumber, n]));

  // 依頼プロンプト
  lines.push('# 対局解説依頼');
  lines.push('');

  if (input.userSide === 'sente' || input.userSide === 'gote') {
    const side = input.userSide === 'sente' ? '先手' : '後手';
    lines.push(
      `以下は **${side}（あなた）が指した対局** です。あなたの視点を中心に解説してください（自分の指し手の意図、改善点、勉強になるポイントなど）。`,
    );
    lines.push('');
    lines.push('次を含む形で解説してください。');
    lines.push('- 戦型・序盤の構想');
    lines.push('- 対局の流れと攻防の要点');
    lines.push('- あなたが指したターニングポイント（悪手・好手）と、その代替案・意図');
    lines.push('- 全体総評（あなたが次に活かす改善点）');
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
    const youMark = input.userSide === 'sente' ? '（あなた）' : '';
    lines.push(`- 先手: ${input.sente}${dan}${youMark}`);
  }
  if (input.gote) {
    const dan = input.goteDan ? `（${input.goteDan}段）` : '';
    const youMark = input.userSide === 'gote' ? '（あなた）' : '';
    lines.push(`- 後手: ${input.gote}${dan}${youMark}`);
  }
  const resultJp = formatResult(input.result);
  if (resultJp) lines.push(`- 結果: ${resultJp}`);
  if (input.playedAt) lines.push(`- 対局日時: ${formatPlayedAt(input.playedAt)}`);
  lines.push('');

  // 評価値推移
  lines.push('## 評価値推移（先手視点 cp、正＝先手有利。⚠＝悪手、◎＝好手）');
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
    const note = notableMap.get(idx);
    let noteStr = '';
    if (note) {
      if (note.label === 'blunder') noteStr = '⚠悪手';
      else if (note.label === 'good') noteStr = '◎好手';
    }
    lines.push(`| ${a.moveNumber} | ${moveStr} | ${evalStr} | ${noteStr} |`);
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

      const labelText =
        n.label === 'blunder' ? '悪手' : n.label === 'good' ? '好手' : '参考';
      const beforeStr = formatSente(n.scoreBefore);
      const afterStr = formatSente(n.scoreAfter);
      const deltaStr = formatSente(n.delta);

      lines.push(
        `### ${idx + 1} 手目 ${turn}${playedJp}（${labelText}、評価値 ${beforeStr} → ${afterStr}、手番側 ${deltaStr}cp）`,
      );
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
