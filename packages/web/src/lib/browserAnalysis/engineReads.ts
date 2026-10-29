/**
 * 全局面解析のエンジンで、1 局面だけを読む（出題の採点の名指し評価・検討盤の局面評価）。
 *
 * エンジンは全局面解析と共用する（{@link EngineCache}。棋譜をまたいで使い回すものと同じ。負荷の設定も同じく効く）。
 * ⚠ 全局面解析と同時に呼ばない（呼び出し側が全局面解析を止めてから呼ぶ。エンジンは 1 本）
 */
import {
  isConclusiveMate,
  namedEvaluationOf,
  namedGoCommand,
  positionCandidatesOf,
  positionGoCommand,
  sfenPositionCommand,
  withAllLegalMoves,
  withMultiPv,
  type BrowserAnalysisSettings as ServerAnalysisSettings,
  type DrillNamedEvaluation,
  type NamedEvalSettings,
  type PositionCandidate,
} from 'shared';
import {
  NEEDS_CONSENT_DETAIL,
  STOPPED_DETAIL,
  type AnalysisEngine,
  type EngineCache,
  type EngineChoice,
  type EngineSettings,
  type RunnerLog,
} from './engineCache';

/** 採点の読み（出題の名指し評価。prd/13 §5.3）で頼まれること。server の応答（`status: 'evaluate'`）の中身 */
export interface NamedEvalRequest {
  /** 読む局面（利用者がいま見ている局面） */
  sfen: string;
  /** 名指しする手（利用者の手） */
  move: string;
  /**
   * 読む設定（server が決める）。次の一手は全局面解析の深い段と同じ（思考時間・置換表・スレッドの上限・読み筋の長さ）。
   * 詰将棋は固定のスレッド数（`threads`）と、最初の正の mate での打ち切り（`stopOnMate`）が付く（prd/13 §5.5）
   */
  settings: NamedEvalSettings;
}

export type NamedEvalOutcome =
  /** 解答に付けて送り直す評価（server の `drillNamedEvaluationSchema` を通る形） */
  | {
      kind: 'ok';
      evaluation: DrillNamedEvaluation;
      /** 最初の正の mate で打ち切った（詰将棋の判定。ログ用。server には送らない） */
      stopped?: boolean;
    }
  /** エンジンが名指しした手を読まなかった（その局面で指せない手など）。🔒 数字を作らず、採点を頼まない */
  | { kind: 'mismatch'; returned: string }
  /** エンジンを読み込めない・読みが失敗した（作り直して 1 度やり直した後） */
  | { kind: 'failed'; detail: string };

/**
 * 検討盤の局面評価（prd/12 §2.2・§2.4）で頼まれること。担当 `browser` の利用者の検討盤が、server を通さずに頼む。
 * 🔒 設定は web の定数（`studyEval.ts` の `STUDY_EVAL_SETTINGS`。server を経由しないため）。
 * エンジンの大きさ（`maxThreads`・`hashMb`）は、エンジンがまだ無いときに作る大きさとしてだけ使う（今あるエンジンを作り直さない）
 */
export interface PositionEvalRequest {
  /** 読む局面（正規化 SFEN。検証済み） */
  sfen: string;
  settings: PositionEvalSettings;
}

/** 局面評価の設定（候補手数・思考時間・読み筋の長さと、エンジンの設定） */
export type PositionEvalSettings = EngineSettings &
  Pick<ServerAnalysisSettings, 'multiPv' | 'movetimeMs' | 'pvMaxPlies'>;

export type PositionEvalOutcome =
  /** 候補手（rank 順。手番側の値）。画面に出すだけで server には送らない */
  | { kind: 'ok'; candidates: PositionCandidate[]; threads: number }
  /** 頼んだ側が取り下げた（局面が変わった）。読み始める前なら読まない・読んでいる途中なら打ち切る */
  | { kind: 'aborted' }
  /** エンジンを読み込めない・読みが失敗した（作り直して 1 度やり直した後） */
  | { kind: 'failed'; detail: string };

export interface EngineReadsDeps {
  /** いま選んでいる評価関数。同意していなければ null（読まない） */
  currentEngine(): EngineChoice | null;
  log: RunnerLog;
}

export interface EngineReads {
  /**
   * 採点の読み（出題の名指し評価）を 1 つ読む（prd/13 §5.3）。`position sfen …` → `go movetime <ms> searchmoves <手>`。
   */
  evaluateNamed(request: NamedEvalRequest): Promise<NamedEvalOutcome>;
  /**
   * 検討盤の局面評価を 1 つ読む（prd/12 §2.2）。`position sfen …` → `go movetime <ms>` を、MultiPV を
   * `settings.multiPv`（3）にして読み、終わったら元の MultiPV に戻す。
   * スレッド数は負荷の設定の数（上限は `settings` の段の上限）。`signal` が中断されたら読まない・読みを打ち切る。
   */
  evaluatePosition(request: PositionEvalRequest, signal: AbortSignal): Promise<PositionEvalOutcome>;
}

type Failed = { kind: 'failed'; detail: string };
type Aborted = { kind: 'aborted' };

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function createEngineReads(deps: EngineReadsDeps, engines: EngineCache): EngineReads {
  const { log } = deps;

  /**
   * エンジンを借りて読む。エンジンが失敗したら（読み込み・読みのどちらでも）捨てて、**1 度だけ**作り直して読み直す
   * （全局面解析と同じく、端末の不調 1 回で諦めない）。2 度続けば `failed`。
   * 止めた後は読み直さない（エンジンを作り直さない）。`signal` が中断されていれば、エンジンを使わずに `aborted`
   */
  function withEngineRetry<T>(
    label: string,
    signal: AbortSignal,
    acquire: () => Promise<AnalysisEngine>,
    read: (engine: AnalysisEngine) => Promise<T>,
  ): Promise<T | Aborted | Failed>;
  function withEngineRetry<T>(
    label: string,
    signal: undefined,
    acquire: () => Promise<AnalysisEngine>,
    read: (engine: AnalysisEngine) => Promise<T>,
  ): Promise<T | Failed>;
  async function withEngineRetry<T>(
    label: string,
    signal: AbortSignal | undefined,
    acquire: () => Promise<AnalysisEngine>,
    read: (engine: AnalysisEngine) => Promise<T>,
  ): Promise<T | Aborted | Failed> {
    let detail = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      // 頼んだ側が取り下げた（待っている間に局面が変わった）。エンジンを使わずに返す
      if (signal?.aborted) return { kind: 'aborted' };
      if (engines.isDisposed()) return { kind: 'failed', detail: STOPPED_DETAIL };
      let current: AnalysisEngine;
      try {
        current = await acquire();
      } catch (error) {
        engines.discard();
        detail = `解析エンジンを読み込めませんでした（${messageOf(error)}）`;
        log.warn(`${label}: engine load failed (${attempt + 1}): ${messageOf(error)}`);
        continue;
      }
      try {
        return await read(current);
      } catch (error) {
        // 死・時間切れ・`info string Error!`。エンジンは必ず作り直す
        engines.discard();
        detail = messageOf(error);
        log.warn(`${label}: engine failed (${attempt + 1}): ${detail}`);
      }
    }
    return { kind: 'failed', detail };
  }

  const evaluateNamed = async (request: NamedEvalRequest): Promise<NamedEvalOutcome> => {
    const { sfen, move, settings } = request;
    const choice = deps.currentEngine();
    if (choice === null) return { kind: 'failed', detail: NEEDS_CONSENT_DETAIL };
    const engineInfo = choice.info;
    return withEngineRetry(
      'drill',
      undefined,
      () => engines.acquire(settings, choice, settings.threads),
      async (current): Promise<NamedEvalOutcome> => {
        // 🔴 不成の手も読めるよう、読みの間だけ GenerateAllLegalMoves を有効にする（終わったら戻す）
        // 詰将棋の判定は、最初に正の mate（bound の付かない info）が出た時点で stop を送って打ち切る（prd/13 §5.5）。
        // 判定と別解の手順には、その info の評価値と読み筋を使う（`namedEvaluationOf` が `stoppedBy` を読む）
        const result = await withAllLegalMoves(current.session, () =>
          current.session.analyze(
            sfenPositionCommand(sfen),
            namedGoCommand(settings.movetimeMs, move),
            settings.stopOnMate ? { stopWhen: isConclusiveMate } : undefined,
          ),
        );
        const named = namedEvaluationOf(result, move, settings.pvMaxPlies);
        if (named.kind === 'mismatch') return named;
        return {
          kind: 'ok',
          ...(result.stoppedBy ? { stopped: true } : {}),
          evaluation: {
            move,
            candidate: named.candidate,
            engineBuild: engineInfo.engineBuild,
            evalHash: engineInfo.evalHash,
            engineName: current.name,
            fvScale: engineInfo.fvScale,
            threads: current.threads,
            hashMb: current.hashMb,
            movetimeMs: settings.movetimeMs,
          },
        };
      },
    );
  };

  const evaluatePosition = async (
    request: PositionEvalRequest,
    signal: AbortSignal,
  ): Promise<PositionEvalOutcome> => {
    const { sfen, settings } = request;
    const choice = deps.currentEngine();
    if (choice === null) return { kind: 'failed', detail: NEEDS_CONSENT_DETAIL };
    return withEngineRetry(
      'position',
      signal,
      // 固定のスレッド数は無い——負荷の設定の数（上限は段の上限。全局面解析の full と同じ決め方）。
      // 🔒 エンジンの大きさ（maxThreads・hashMb）は今あるエンジンのものを使う（大きさの違いで作り直さない。prd/12 §2.4）
      () => engines.acquire(settings, choice, undefined, { followCurrentSizing: true }),
      async (current): Promise<PositionEvalOutcome> => {
        // 🔴 局面評価は MultiPV を自分で設定してから読み、終わったら戻す（全局面解析は MultiPV 1。prd/12 §2.2）。
        // 取り下げられたら次の info で stop を送って打ち切る（結果は捨てる）
        const result = await withMultiPv(current.session, settings.multiPv, () =>
          current.session.analyze(sfenPositionCommand(sfen), positionGoCommand(settings.movetimeMs), {
            stopWhen: () => signal.aborted,
          }),
        );
        if (signal.aborted) return { kind: 'aborted' };
        return {
          kind: 'ok',
          candidates: positionCandidatesOf(result, settings.multiPv, settings.pvMaxPlies),
          threads: current.threads,
        };
      },
    );
  };

  return { evaluateNamed, evaluatePosition };
}
