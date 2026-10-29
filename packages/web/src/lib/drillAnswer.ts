/**
 * 出題の解答の口（`POST /api/drills/:kifuNo/:moveNumber/:kind/answer`。prd/13 §5.3）の応答を、次にすることで分ける。
 *
 * - `wait-job`（202 `pending`）: 手元 worker の名指し評価を待って、同じ本文を投げ直す（担当がサーバーのとき）
 * - `evaluate`（200 `evaluate`）: このブラウザのエンジンで名指しで読み、結果を付けて同じ解答を送り直す
 *   （次の一手は担当がブラウザのとき・詰将棋は担当によらず。読めなければ「読めない」と申告して送り直す。prd/13 §5.5）
 * - `continue` / `done`: 詰みが続く / 採点が確定した
 * - `miss`（詰将棋）: 間違えた手（王手でない・詰まない）。その手を取り消して続ける。答えは載らない（prd/13 §5.2）
 *
 * 🔒 **判定は server**。ここは応答の振り分けと、送り直しの本文の組み立てだけ。
 */
import type { DrillNamedEvaluation, NamedEvalSettings } from 'shared';
import type { GradingResult } from './browserAnalysis/grading';
import type { BrowserAnalysisPhase } from './browserAnalysis/store';

/** 解答の本文（送り直しても `line` と線引きは変えない） */
export interface AnswerBody {
  line: string[];
  correctMargin?: number;
  closeMargin?: number;
  evaluation?: DrillNamedEvaluation;
  /**
   * この端末のエンジンでは読めない（同意しない・解析できない環境・エンジンが無い・読みが失敗した。prd/13 §5.5）。
   * 詰将棋で付ける。server は担当がサーバーならそれを見て手元 worker で判定する
   */
  browserUnavailable?: boolean;
  /**
   * 練習（記録しない）。🔒 その問題の記録が済んだ後の操作（最初の間違い・答えを見た・解答後のやり直しの後）は
   * すべて練習で送る（prd/13 §6.2）
   */
  practice?: boolean;
}

/** 詰将棋で間違えた理由。`not_check` は王手でない手、`no_mate` は詰まない手（prd/13 §5.2） */
export type MissReason = 'not_check' | 'no_mate';

/** ブラウザに読ませる局面と手（`status: 'evaluate'` の中身） */
export interface EvaluateRequest {
  sfen: string;
  move: string;
  /** 読む設定（server が決める。詰将棋は固定のスレッド数・打ち切りが付く） */
  settings: NamedEvalSettings;
}

export type AnswerStep<Done> =
  | { kind: 'wait-job'; jobId: string }
  | { kind: 'evaluate'; request: EvaluateRequest }
  | { kind: 'continue'; reply: string }
  | { kind: 'miss'; reason: MissReason; refutation: string[] }
  | { kind: 'done'; result: Done }
  | { kind: 'error'; text: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

function isSettings(value: unknown): value is NamedEvalSettings {
  if (!isRecord(value)) return false;
  return (
    ['movetimeMs', 'multiPv', 'hashMb', 'maxThreads', 'chunkIntervalMs', 'chunkMaxPositions', 'pvMaxPlies'].every(
      (key) => typeof value[key] === 'number',
    ) &&
    (value.threads === undefined || typeof value.threads === 'number') &&
    (value.stopOnMate === undefined || typeof value.stopOnMate === 'boolean')
  );
}

/**
 * 応答（HTTP ステータスと、読めた本文。読めなければ null）を次にすることにする。
 * ⚠ 本文を読めない（前段が返す HTML など）ときは、ステータスで文を作る（通信断と取り違えない。prd/12 §2.4）
 */
export function answerStepOf<Done>(status: number, body: unknown): AnswerStep<Done> {
  if (status === 202) {
    if (isRecord(body) && typeof body.jobId === 'string') return { kind: 'wait-job', jobId: body.jobId };
    return { kind: 'error', text: `サーバーエラー (${status})` };
  }
  if (status < 200 || status >= 300) {
    if (isRecord(body) && 'error' in body) return { kind: 'error', text: String(body.error) };
    return { kind: 'error', text: `サーバーエラー (${status})` };
  }
  if (!isRecord(body)) return { kind: 'error', text: `サーバーエラー (${status})` };
  switch (body.status) {
    case 'evaluate':
      if (typeof body.sfen === 'string' && typeof body.move === 'string' && isSettings(body.settings)) {
        // 🔒 設定は server の値をそのまま使う（ブラウザが決めない）
        return { kind: 'evaluate', request: { sfen: body.sfen, move: body.move, settings: body.settings } };
      }
      break;
    case 'continue':
      if (typeof body.reply === 'string') return { kind: 'continue', reply: body.reply };
      break;
    case 'miss':
      if (body.wrongReason === 'not_check' || body.wrongReason === 'no_mate') {
        const refutation = Array.isArray(body.refutation)
          ? body.refutation.filter((m): m is string => typeof m === 'string')
          : [];
        return { kind: 'miss', reason: body.wrongReason, refutation };
      }
      break;
    case 'done':
      return { kind: 'done', result: body as Done };
  }
  return { kind: 'error', text: `サーバーエラー (${status})` };
}

/**
 * ブラウザで読んだ結果を付けた、送り直しの本文。🔒 **`line` と線引きは最初の解答のまま**（server は同じ解答として判定する）
 */
export function answerBodyWithEvaluation(body: AnswerBody, evaluation: DrillNamedEvaluation): AnswerBody {
  return { ...body, evaluation };
}

/**
 * 「この端末では読めない」を申告する送り直しの本文（詰将棋。prd/13 §5.5）。`line` と線引きは最初の解答のまま。
 * server は担当がサーバーなら手元 worker で判定し（`pending`）、担当がブラウザならまた `evaluate` を返す（このとき画面は採点できない旨を出す）
 */
export function answerBodyUnavailable(body: AnswerBody): AnswerBody {
  return { ...body, browserUnavailable: true };
}

/**
 * `evaluate` を受けたときにすること（prd/13 §5.3・§5.5）。
 * - `read`: このブラウザで読む
 * - `give-up`: 読んだ結果を付けた・読めないと申告した送り直しに、また `evaluate` が返った（噛み合っていない・担当がブラウザで読めない）。回り続けない
 */
export function onEvaluate(body: AnswerBody): 'read' | 'give-up' {
  return body.evaluation || body.browserUnavailable ? 'give-up' : 'read';
}

/** エンジンが使える（か、読み込み中でじきに使える）状態 */
const ENGINE_USABLE: ReadonlySet<BrowserAnalysisPhase> = new Set(['idle', 'loading', 'analyzing']);

/**
 * この端末のエンジンで採点できなかった手を、**同じ手で判定し直してよいか**（prd/13 §7.1・2026-10-29）。
 * 採点できなかったときの状態（同意の前・止まっていた・起動の途中）から、使える状態へ移ったときだけ true。
 * 🔒 **使える状態のまま採点できなかったなら判定し直さない**——解析の状態が動くたびに送り直して回り続けるため
 */
export function retriesAfterEngineReady(failedAt: BrowserAnalysisPhase, now: BrowserAnalysisPhase): boolean {
  return !ENGINE_USABLE.has(failedAt) && ENGINE_USABLE.has(now);
}

/**
 * 採点できなかった結果から、エンジンの準備を待って判定し直すときの**基準の状態**（{@link retriesAfterEngineReady} の `failedAt`）。
 * エンジンを使えない（`unavailable`）ときだけ、その結果が返った時点の状態を返す。それ以外（読みの失敗・噛み合わない）は待たない（null）。
 * 🔴 **画面が判定を諦めた時点の状態ではなく、この時点の状態を基準にする**（レビュー `OCL-239BA9E5`）——詰将棋は読めない旨を申告して
 * server に送り直すので、その応答を待つ間に同意されると、諦めた時点ではもう使える状態（`loading` など）になっていて二度と判定し直さない
 */
export function engineWaitFromOf(
  result: Exclude<GradingResult, { kind: 'ok' }>,
  phaseAtResult: BrowserAnalysisPhase,
): BrowserAnalysisPhase | null {
  return result.kind === 'unavailable' ? phaseAtResult : null;
}

/** 間違えた手の案内（prd/13 §7.1）。🔒 内部の用語を出さない */
export function missText(reason: MissReason): string {
  return reason === 'not_check' ? '王手ではありません' : 'その手では詰みません';
}

/**
 * 「1 手戻す」の後の手順（詰将棋。受方の応手と自分の手の 2 手ぶん戻す）。
 * 戻せない（手順の先頭）なら null
 */
export function lineAfterUndoTurn(line: readonly string[]): string[] | null {
  return line.length >= 2 ? line.slice(0, -2) : null;
}

/**
 * 詰み上がりの手数（「13 手で詰み（最短 7 手）」）。最短の想定（当初の正解手順の手数）が無い・同じなら括弧を付けない
 */
export function matePliesText(plies: number, answerPlies: number | null): string {
  const head = `${plies} 手で詰み`;
  return answerPlies !== null && answerPlies !== plies ? `${head}（最短 ${answerPlies} 手）` : head;
}

/**
 * 練習で解いた結果に添える一言（prd/13 §7.1）。記録済みの判定で分ける。記録した解答（練習でない）なら null
 */
export function practiceNote(
  practice: boolean,
  recorded: 'correct' | 'close' | 'wrong' | null,
): string | null {
  if (!practice) return null;
  return recorded === 'wrong' ? '記録は不正解のままです' : '練習のため記録していません';
}

/**
 * 解答履歴の手の欄（prd/13 §7.3）。「諦めて答えを見る」の行（判定あり・手なし）は「（諦めた）」。
 * 除外だけの行（判定も手も無い）は「—」
 */
export function attemptMoveLabel(row: { verdict: string | null; move: string | null; moveText: string | null }): string {
  if (row.move === null) return row.verdict !== null ? '（諦めた）' : '—';
  return row.moveText ?? row.move;
}

/**
 * 結果の札（prd/13 §7.1）。🔴 **練習で詰ませた（記録は別に確定済み）ときは「詰み」**——緑の「正解」にすると、
 * 「記録は不正解のままです」と並んで紛らわしい。記録した解答・次の一手は判定どおり
 */
export function resultBadge(
  kind: 'mate' | 'best',
  verdict: 'correct' | 'close' | 'wrong',
  practice: boolean,
): { label: string; className: string } {
  if (kind === 'mate' && verdict === 'correct' && practice) {
    return { label: '詰み', className: 'badge-success badge-outline' };
  }
  return VERDICT_BADGE[verdict];
}

const VERDICT_BADGE = {
  correct: { label: '正解', className: 'badge-success' },
  close: { label: '惜しい', className: 'badge-warning' },
  wrong: { label: '不正解', className: 'badge-error' },
} as const;
