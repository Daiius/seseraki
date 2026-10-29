import { client } from './honoClient';
import type { AnalysisAssignee } from './auth';
import type { DrillMode, DrillRef, DrillsSearch } from './drillSearch';
import {
  answerBodyUnavailable,
  answerBodyWithEvaluation,
  answerStepOf,
  engineWaitFromOf,
  onEvaluate,
  type AnswerBody,
  type MissReason,
} from './drillAnswer';
import {
  gradingFailureMessage,
  requestBrowserGrading,
  type GradingResult,
} from './browserAnalysis/grading';
import {
  getBrowserAnalysisState,
  subscribeBrowserAnalysisState,
  type BrowserAnalysisPhase,
} from './browserAnalysis/store';
import { askDrillEngineConsent } from './browserAnalysis/drillEngine';

/*
  出題（prd/13）の通信。`routes/drills.tsx` から切り出した。
  画面ごとの読み込み（loader が使う）と、解答の送信（判定が出るまでの往復）を置く。
*/

export type Drill = NonNullable<Awaited<ReturnType<typeof loadOne>>['drill']>;
export type SolveData = { drill: Drill | null; error: string | null };

export async function loadCounts() {
  try {
    const res = await client.api.drills.counts.$get();
    if (!res.ok) return { counts: null, error: `サーバーエラー (${res.status})` };
    return { counts: await res.json(), error: null };
  } catch {
    return { counts: null, error: 'サーバーに接続できません' };
  }
}

export async function loadNext(mode: DrillMode, since: string | null) {
  try {
    const res = await client.api.drills.next.$get({ query: { mode, ...(since ? { since } : {}) } });
    if (!res.ok) return { drill: null, now: null, error: `サーバーエラー (${res.status})` };
    const body = await res.json();
    return { drill: body.drill, now: body.now, error: null };
  } catch {
    return { drill: null, now: null, error: 'サーバーに接続できません' };
  }
}

/** 問題を指す組（棋譜の番号・手数・種類。prd/14 §4.4）を API のパス引数へ */
export function refParam(ref: DrillRef) {
  return {
    kifuNo: String(ref.kifuNo),
    moveNumber: String(ref.moveNumber),
    kind: ref.kind,
  };
}

/** 出題（`/drills/next` などが返す 1 問）から、それを指す組を取り出す */
export function refOf(drill: DrillRef): DrillRef {
  return { kifuNo: drill.kifuNo, moveNumber: drill.moveNumber, kind: drill.kind };
}

/** 名指しの 1 問（prd/13 §5.4）。返る形は `/drills/next` と同じ */
export async function loadOne(ref: DrillRef) {
  try {
    const res = await client.api.drills[':kifuNo'][':moveNumber'][':kind'].$get({
      param: refParam(ref),
    });
    if (res.status === 404) return { drill: null, now: null, error: '出題が見つかりません' };
    if (!res.ok) return { drill: null, now: null, error: `サーバーエラー (${res.status})` };
    const body = await res.json();
    return { drill: body.drill, now: body.now, error: null };
  } catch {
    return { drill: null, now: null, error: 'サーバーに接続できません' };
  }
}

export async function loadList(search: DrillsSearch) {
  try {
    const res = await client.api.drills.$get({
      query: {
        page: search.page ?? 1,
        ...(search.kind ? { kind: search.kind } : {}),
        ...(search.solved ? { status: search.solved } : {}),
      },
    });
    if (!res.ok) return { list: null, error: `サーバーエラー (${res.status})` };
    return { list: await res.json(), error: null };
  } catch {
    return { list: null, error: 'サーバーに接続できません' };
  }
}

/** 解答後に server が明かす情報（prd/13 §5.3） */
export interface Reveal {
  verdict: 'correct' | 'close' | 'wrong';
  lossCp: number | null;
  refutation?: string[];
  /** 棋譜の番号（所有者ごと。prd/14 §4.4） */
  kifuNo: number;
  moveNumber: number;
  reason: 'missed_mate' | 'own_blunder';
  answerMove: string;
  answerPv: string[] | null;
  playedMove: string | null;
  playedLossCp: number | null;
  /** ユーザーの手順の手数（詰将棋の詰み上がりに出す） */
  plies: number;
  /** 当初の正解手順の手数 */
  answerPlies: number | null;
  /** 「答えを見る」で出した結果 */
  gaveUp?: boolean;
}

/** ポーリングの間隔と総予算。server の期限（最大 240 秒）に合わせて切る（prd/12 §2.4） */
const POLL_INTERVAL_MS = 1500;
const POLL_BUDGET_MS = 240_000;

/**
 * `ms` だけ待つ。`signal` が中断されたら待たずに戻る（戻った後に呼び出し側が `signal.aborted` を見る）
 */
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/** 判定が出るまで待つ。**ポーリングは呼び出し側から見えない**（prd/12 §2.4）。中断されたら待つのをやめる */
async function waitForEvaluation(jobId: string, deadline: number, signal: AbortSignal): Promise<void> {
  while (Date.now() < deadline) {
    await pause(POLL_INTERVAL_MS, signal);
    if (signal.aborted) return;
    const res = await client.api.positions.evaluate[':jobId'].$get({ param: { jobId } }, { init: { signal } });
    // 404 は TTL 切れ / server 再起動。**同じ body を投げ直せばよい**ので待ちを抜ける
    if (res.status === 404) return;
    if (!res.ok) return;
    const body = (await res.json()) as { status?: string };
    if (body.status !== 'pending') return;
  }
}

/** 解答（`requestAnswer`）の行き着いた先。画面はこれを見て盤と表示を進める */
export type AnswerOutcome =
  /**
   * 判定できなかった。`waitEngineFrom` が null でなければ、エンジンの準備（同意・ダウンロード）を待てば
   * 判定し直せる（その時点のエンジンの状態。`drillAnswer.ts` の `retriesAfterEngineReady` の基準）
   */
  | { kind: 'fail'; text: string; waitEngineFrom: BrowserAnalysisPhase | null }
  /** 詰みの指し継ぎ。受方の応手（prd/13 §5.2） */
  | { kind: 'continue'; reply: string }
  /** 詰将棋で間違えた手（prd/13 §5.3） */
  | { kind: 'miss'; reason: MissReason; refutation: string[] }
  | { kind: 'done'; result: Reveal }
  /**
   * 呼び出し側が取り下げた（解いている画面を離れた）。🔒 **画面は何もしない**——状態も「この回」の記録（`drillRound`）も触らない。
   * 離れた後に古い応答で記録すると、ホームで終えた回が 1 問だけの回として作り直される
   */
  | { kind: 'aborted' };

const ABORTED = { kind: 'aborted' } as const;

/**
 * 解答を送り、判定が出るまで往復する（prd/13 §5.3）。ジョブの待ち（ポーリング）と、
 * 「この局面のこの手を名指しで読んで」へのこのブラウザのエンジンでの応答もここで済ませる。
 * 🔒 **画面の状態には触らない**——結末（{@link AnswerOutcome}）だけを返す。
 * `signal` が中断されたら、通信・ポーリング・このブラウザでの読み（の順番待ち）を打ち切って `aborted` を返す。
 */
export async function requestAnswer(
  drill: Drill,
  answerBody: AnswerBody,
  assignee: AnalysisAssignee,
  signal: AbortSignal,
): Promise<AnswerOutcome> {
  let body = answerBody;
  let deadline = Date.now() + POLL_BUDGET_MS;
  /** このブラウザで読めなかった理由（読めない旨を申告した後、サーバーでも判定されなかったときに出す） */
  let unreadable: Exclude<GradingResult, { kind: 'ok' }> | null = null;
  /**
   * 読めなかった時点のエンジンの状態（判定し直しの基準）。🔴 送り直しの応答を待つ間に同意されても、
   * この値で判定し直す（諦めた時点の状態を使うと、もう使える状態なので二度と判定し直さない。レビュー `OCL-239BA9E5`）
   */
  let unreadableFrom: BrowserAnalysisPhase | null = null;
  try {
    while (Date.now() < deadline) {
      if (signal.aborted) return ABORTED;
      const res = await client.api.drills[':kifuNo'][':moveNumber'][':kind'].answer.$post(
        { param: refParam(drill), json: body },
        { init: { signal } },
      );
      // ⚠ **本文のパースはステータス判定より後**（前段が返す HTML で落ちると、
      // 通信断でもないのに「接続できません」と出る。prd/12 §2.4）
      const step = answerStepOf<Reveal>(res.status, await res.json().catch(() => null));
      if (signal.aborted) return ABORTED;
      switch (step.kind) {
        case 'wait-job':
          await waitForEvaluation(step.jobId, deadline, signal);
          continue;
        case 'evaluate': {
          // 🔒 読んだ結果を付けて送り直したのに、また読んでと返る ＝ 噛み合っていない。回り続けない。
          // 読めないと申告してまた返る ＝ サーバーでも判定できない（ブラウザで解析する利用者）。読めなかった理由を出す
          if (onEvaluate(body) === 'give-up') {
            return {
              kind: 'fail',
              text: unreadable ? gradingFailureMessage(unreadable) : '判定できませんでした。もう一度お試しください',
              waitEngineFrom: unreadableFrom,
            };
          }
          // このブラウザのエンジンで名指しで読む（全局面解析より先に。prd/14 §5.10）。
          // サーバーで解析する利用者の詰将棋は、同意の前ならここで同意を待つ（断ったらサーバーで判定する。prd/13 §5.5）
          const graded = await requestBrowserGrading(
            step.request,
            {
              getPhase: () => getBrowserAnalysisState().phase,
              subscribe: subscribeBrowserAnalysisState,
              setTimeout: (callback, ms) => setTimeout(callback, ms),
              clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
              ...(assignee === 'worker' && drill.kind === 'mate' ? { askConsent: askDrillEngineConsent } : {}),
            },
            signal,
          );
          if (graded.kind === 'aborted' || signal.aborted) return ABORTED;
          const gradedFrom =
            graded.kind === 'ok' ? null : engineWaitFromOf(graded, getBrowserAnalysisState().phase);
          if (graded.kind !== 'ok' && drill.kind === 'mate') {
            // 詰将棋は「この端末では読めない」と申告して送り直す（サーバーで解析する利用者はサーバーで判定される）
            unreadable = graded;
            unreadableFrom = gradedFrom;
            body = answerBodyUnavailable(body);
            deadline = Date.now() + POLL_BUDGET_MS;
            continue;
          }
          if (graded.kind !== 'ok') {
            return { kind: 'fail', text: gradingFailureMessage(graded), waitEngineFrom: gradedFrom };
          }
          body = answerBodyWithEvaluation(body, graded.evaluation);
          // エンジンの準備（初回のダウンロード）に掛かった時間は、送り直しの待ちに数えない
          deadline = Date.now() + POLL_BUDGET_MS;
          continue;
        }
        case 'error':
          return { kind: 'fail', text: step.text, waitEngineFrom: null };
        case 'continue':
          return { kind: 'continue', reply: step.reply };
        case 'miss':
          return { kind: 'miss', reason: step.reason, refutation: step.refutation };
        case 'done':
          return { kind: 'done', result: step.result };
      }
    }
    if (signal.aborted) return ABORTED;
    return { kind: 'fail', text: '判定が終わりませんでした。もう一度お試しください', waitEngineFrom: null };
  } catch {
    // 取り下げで fetch が中断された（AbortError）のは通信断ではない
    if (signal.aborted) return ABORTED;
    return { kind: 'fail', text: 'サーバーに接続できません', waitEngineFrom: null };
  }
}

/**
 * 答えを見る（諦め。prd/13 §5.3）。**確定した手順だけ**を送る（確定前の手は捨てる）。
 * `signal` が中断されたら `aborted`（{@link AnswerOutcome} の `aborted` と同じく、画面は何もしない）
 */
export async function requestGiveUp(
  drill: Drill,
  line: string[],
  practice: boolean,
  signal: AbortSignal,
): Promise<{ kind: 'done'; result: Reveal } | { kind: 'error'; text: string } | { kind: 'aborted' }> {
  try {
    if (signal.aborted) return ABORTED;
    const res = await client.api.drills[':kifuNo'][':moveNumber'][':kind']['give-up'].$post(
      { param: refParam(drill), json: { line, practice } },
      { init: { signal } },
    );
    const step = answerStepOf<Reveal>(res.status, await res.json().catch(() => null));
    if (signal.aborted) return ABORTED;
    if (step.kind === 'done') return step;
    return { kind: 'error', text: step.kind === 'error' ? step.text : `サーバーエラー (${res.status})` };
  } catch {
    if (signal.aborted) return ABORTED;
    return { kind: 'error', text: 'サーバーに接続できません' };
  }
}
