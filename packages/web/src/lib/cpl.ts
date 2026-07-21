/**
 * centipawn loss (CPL) による悪手判定。
 *
 * CPL = 最善手の評価 − 実手の評価（いずれも**手番側視点**）。同一局面・同一手番の比較なので
 * 先手視点への正規化も符号反転も要らない（正規化は表示用途に限る。`toSenteEval`）。
 * 実手の評価は、**実手が候補手に含まれていればその `scoreValue`、含まれていなければ次局面の
 * 最善値を符号反転**して得る（後者は 1 手進んだ局面から読んだ値なので読みの深さが揃わず**近似**）。
 *
 * 閾値は**表示のフィルタ**でしかなく CPL 自体は閾値に依存しないため、算出（`computeMoveLosses`）と
 * ラベル付け（`labelOf`）を分けている。閾値を変えても再計算は要らない。
 *
 * 仕様は prd/01-domain.md §5 / prd/05-analysis.md §2.3。
 */

export interface CplCandidate {
  rank: number;
  move: string;
  scoreType: string;
  scoreValue: number;
}

export interface CplAnalysis {
  moveNumber: number;
  candidates: CplCandidate[];
}

/** 段階ラベルの閾値。UI から変更でき localStorage に保持する（prd/05-analysis.md §2.5） */
export interface Thresholds {
  /** CPL がこの値以上なら悪手 */
  blunder: number;
  /** CPL がこの値以上・悪手閾値未満なら疑問手 */
  dubious: number;
  /** 局面の最善評価値の絶対値がこの値以上なら勝負が決したとみなしラベルを付けない */
  decided: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  blunder: 300,
  dubious: 150,
  decided: 1000,
};

/**
 * 詰みが絡む変化。詰みは連続量ではなく cp に写像すると平均 CPL を壊すため、
 * CPL を計算せず別カテゴリとして扱う。
 */
export interface MateEvent {
  /** missed = 自分の詰みを逃した / into = 詰まされる筋に入った */
  kind: 'missed' | 'into';
  /** 詰み手数（短いほど重い。評価値グラフではマーカーの赤さで表す） */
  moves: number;
}

export interface MoveLoss {
  /** 実手を指す前の局面（= その手の moveNumber） */
  moveNumber: number;
  /** 局面の最善評価値（手番側視点 cp）。mate なら null。決着判定には絶対値だけを使う */
  bestCp: number | null;
  /** 手番側の損失（cp）。mate が絡む手では null */
  loss: number | null;
  /** 実手が候補手リスト外で、次局面の最善値から近似したか */
  approximate: boolean;
  /** 詰み系（loss が null のときのみ入りうる） */
  mate: MateEvent | null;
}

export type MoveLabel = 'blunder' | 'dubious' | 'mate' | null;

/**
 * 詰みが絡む変化を分類する。
 *
 * - 自分の詰みがあったのに実手が詰みでない → 詰み逃し
 * - 実手で詰まされる筋に入った（**もともと詰まされていた局面は除く**）→ 詰まされ
 *
 * 詰み → より長手数の詰み（詰みの遠回り）は勝敗が動かないためカテゴリを設けない。
 * これを入れると詰み手順の各手が軒並みラベル対象になり目印として機能しなくなる。
 */
function classifyMate(
  best: CplCandidate,
  playedType: string,
  playedValue: number,
): MateEvent | null {
  const bestIsMate = best.scoreType === 'mate';
  const playedIsMate = playedType === 'mate';

  if (bestIsMate && best.scoreValue > 0 && !(playedIsMate && playedValue > 0)) {
    return { kind: 'missed', moves: best.scoreValue };
  }
  if (playedIsMate && playedValue < 0 && !(bestIsMate && best.scoreValue < 0)) {
    return { kind: 'into', moves: -playedValue };
  }
  return null;
}

/**
 * 各実手の CPL を算出する。キーは実手を指す前の局面（moveNumber）。
 *
 * 判定できない手（実手が候補外で次局面の解析も無い）はエントリを作らない。
 * **実手が候補内なら次局面が要らない**ため、詰みで終わった棋譜の最終手（頓死）も判定できる
 * （エンジンは詰み局面で info 行を返さず候補が空になる）。
 */
export function computeMoveLosses(
  analyses: CplAnalysis[],
  usiMoves: string[],
): Map<number, MoveLoss> {
  const byMoveNumber = new Map<number, CplAnalysis>();
  for (const a of analyses) {
    if (a.candidates.length > 0) byMoveNumber.set(a.moveNumber, a);
  }

  const result = new Map<number, MoveLoss>();
  for (const [moveNumber, analysis] of byMoveNumber) {
    const played = usiMoves[moveNumber];
    if (!played) continue;
    const best = analysis.candidates.find((c) => c.rank === 1);
    if (!best) continue;

    const playedCandidate = analysis.candidates.find((c) => c.move === played);
    let playedType: string;
    let playedValue: number;
    let approximate: boolean;
    if (playedCandidate) {
      playedType = playedCandidate.scoreType;
      playedValue = playedCandidate.scoreValue;
      approximate = false;
    } else {
      // 候補外の実手は次局面の最善値から測る。1 手進んで手番が入れ替わるので符号を反転する
      const nextBest = byMoveNumber
        .get(moveNumber + 1)
        ?.candidates.find((c) => c.rank === 1);
      if (!nextBest) continue;
      playedType = nextBest.scoreType;
      playedValue = -nextBest.scoreValue;
      approximate = true;
    }

    const mateInvolved = best.scoreType === 'mate' || playedType === 'mate';
    result.set(moveNumber, {
      moveNumber,
      bestCp: best.scoreType === 'mate' ? null : best.scoreValue,
      loss: mateInvolved ? null : best.scoreValue - playedValue,
      approximate,
      mate: mateInvolved ? classifyMate(best, playedType, playedValue) : null,
    });
  }
  return result;
}

/**
 * CPL に段階ラベルを付ける。
 *
 * 勝負が決した局面（|最善評価値| ≧ 決着閾値）にはラベルを付けない——挽回不能な局面のぬるい手に
 * 学びは薄く、平均 CPL に混ぜると指標が汚れる。**詰み系は cp の量ではないので決着閾値の対象外**で、
 * 常にラベルが付く（詰み逃しは勝勢の局面でこそ起きる）。
 */
export function labelOf(l: MoveLoss, thresholds: Thresholds): MoveLabel {
  if (l.mate) return 'mate';
  if (l.loss === null) return null;
  if (l.bestCp !== null && Math.abs(l.bestCp) >= thresholds.decided) return null;
  if (l.loss >= thresholds.blunder) return 'blunder';
  if (l.loss >= thresholds.dubious) return 'dubious';
  return null;
}

/** バッジ等に出す短いラベル名。ラベルが無ければ null */
export function labelText(l: MoveLoss, label: MoveLabel): string | null {
  if (label === 'mate') {
    if (!l.mate) return null;
    return l.mate.kind === 'missed'
      ? `詰み逃し（${l.mate.moves}手詰）`
      : `詰まされ（${l.mate.moves}手詰）`;
  }
  if (label === 'blunder') return '悪手';
  if (label === 'dubious') return '疑問手';
  return null;
}

/**
 * 損失の数値表示。近似（実手が候補外）には `≈` を添える。
 * 近似では実手の方が最善手より良い値になり損失が負になることがあり、そのまま符号付きで出す。
 */
export function formatLoss(l: MoveLoss): string | null {
  if (l.loss === null) return null;
  return `損失 ${l.approximate ? '≈' : ''}${l.loss}cp`;
}
