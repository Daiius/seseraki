/**
 * 解析の報告と、解析の担当（`worker` / `browser`）にまつわる書き込みの本体（prd/14 §5.7〜§5.9）。
 *
 * 🔒 **tx を受ける関数だけを置く**（グローバルの `db` も system ロールのプールも import しない）。
 * 同じ関数を 2 つの経路が使う:
 * - 手元 worker の経路（`worker-routes.ts`。API_KEY・system ロールの tx・棋譜は内部 ID で指す）
 * - ブラウザ解析の受け口（`route.ts`。セッション・**RLS の下の tx**・棋譜は所有者と番号で指す）
 *
 * 世代の照合・完了の確定・`fullCount` の規則（prd/16 §4）を経路ごとに書き分けないためで、
 * 経路で違うのは「誰の報告か（担当）」と「棋譜をどう指すか」だけ。
 *
 * 🔒 **ロックの順序はどの関数も「`users` → `kifus` → `kifu_analyses`」**（取らない段は飛ばす）。
 * - 報告・開始・失敗の記録: 棋譜の行を `FOR UPDATE` で取り、その下で `users.analysisAssignee` を**ロックせずに**読む
 * - 担当の切り替え: `users` の行を先に取り、そのユーザーの未完了の棋譜を `id` 順に `FOR UPDATE`
 * - 取り込み（`insertKifu`）も `users` の行を先に取る（番号の採番）ので、切り替えと直列になる
 *
 * これで切り替えと報告は棋譜の行で直列になる（prd/14 §5.7 規則 1）: 報告が先なら切り替えがそれを含めて消し、
 * 切り替えが先なら報告は古い世代・担当違いとして落ちる。
 */
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { BROWSER_ANALYSIS_LIMITS } from 'shared';
import type { Tx } from './db/index.js';
import { kifuAnalyses, kifus, users } from './db/schema.js';
import {
  ANALYSIS_STATE_RESET,
  isAnalysisComplete,
  isChunkAcceptable,
  isChunkInRange,
  isStageComplete,
  nextKifuProfile,
  type AnalysisProfile,
} from './analysis-submit.js';
import { drillConfigFromEnv, syncDrills } from './drills.js';
import { mergeChunk, type AnalysisRun, type CandidateInput } from './kifu-analysis-detail.js';
import { loadAnalysis, saveAnalysis } from './kifu-analysis-store.js';
import { OWNER_USER_ID } from './users.js';

/** 解析の担当（`users.analysisAssignee`。prd/14 §5.7） */
export type AnalysisAssignee = 'worker' | 'browser';

/**
 * ブラウザ解析の 1 局面の思考時間（`go movetime`）を段ごとに（prd/14 §5.2）。
 * 2026-10-15 に dev の複数局で、本番と同じ設定の手元 worker の full と比べて確定した値:
 * full 600ms は最善手・悪手 / 疑問手の印の一致とも、手元 worker の full 同士の揺らぎと同じ水準
 */
export const BROWSER_ANALYSIS_MOVETIME_MS: Record<AnalysisProfile, number> = {
  quick: 100,
  full: 600,
};

/**
 * ブラウザ解析の段ごとのスレッド数の上限（prd/14 §5.5。2026-10-29 決定）。開始の口の `settings.stageMaxThreads`。
 * ブラウザは論理コア数とこれの小さいほうを使う（負荷「控えめ」はその半分）。
 * - full は 4: つようら王11mini の実測で、600ms の 8 スレッドと 4 スレッドは区別できない（最善手の一致・評価値の差・深さとも同じ水準）。
 *   端末の発熱を抑える
 * - quick は `maxThreads` のまま（8）
 *
 * 🔒 **`maxThreads`（エンジンの上限）とは別の欄にする。** web はエンジンを `maxThreads` で作り、段の開始で
 * `setoption Threads` でこの数に合わせる（段が変わるたびに評価関数を読み直さない）。この欄を知らない web は
 * これまでどおり `maxThreads` で回る（壊れない）
 */
export const BROWSER_ANALYSIS_STAGE_MAX_THREADS: Record<AnalysisProfile, number> = {
  quick: 8,
  full: 4,
};

/**
 * ブラウザ解析の設定のうち、段で共通のもの（開始の口が返す。prd/14 §5.2・§5.5・§5.8）。
 * web に焼き込まず server の定数にしておく——値を調整するときに web の再デプロイを要さない。
 */
export const BROWSER_ANALYSIS_SETTINGS = {
  multiPv: 1,
  /** 置換表（`USI_Hash`） */
  hashMb: 64,
  /** スレッド数の上限。ブラウザは論理コア数とこれの小さいほうを使う */
  maxThreads: 8,
  /** チャンクを送る間隔の目安 */
  chunkIntervalMs: 5000,
  /** 1 チャンクの局面数の上限（server の検証と同じ値） */
  chunkMaxPositions: BROWSER_ANALYSIS_LIMITS.chunkMaxPositions,
  /** 読み筋の長さの上限（server の検証と同じ値。これで切ってから送る） */
  pvMaxPlies: BROWSER_ANALYSIS_LIMITS.pvMaxPlies,
} as const;

/**
 * 開始の口が返す、ある段の設定。
 * 🔒 **`movetimeMs` は「その段の思考時間」**——1 段のまま `settings.movetimeMs` を読んで回す web
 * （2 段化の前のコード）でも、開始のたびに server が決めた段の時間で回る（quick → full の順に）
 * - `stageMaxThreads` は「その段のスレッド数の上限」（{@link BROWSER_ANALYSIS_STAGE_MAX_THREADS}）
 */
export function browserAnalysisSettingsFor(profile: AnalysisProfile) {
  return {
    ...BROWSER_ANALYSIS_SETTINGS,
    movetimeMs: BROWSER_ANALYSIS_MOVETIME_MS[profile],
    stageMaxThreads: BROWSER_ANALYSIS_STAGE_MAX_THREADS[profile],
  };
}

/** 開始の口が返す設定の形 */
export type BrowserStageSettings = ReturnType<typeof browserAnalysisSettingsFor>;

/**
 * ブラウザ解析で、いま回す段（prd/14 §5.8）。🔒 **段はブラウザが決めず、棋譜の状態から server が決める**:
 * quick が未完了なら quick、quick が完了していれば full（full の完了は呼び出し側が先に除く）
 */
export function browserStageOf(kifu: {
  completedAt: Date | null;
  analysisProfile: AnalysisProfile | null;
}): AnalysisProfile {
  return isStageComplete(kifu, 'quick') ? 'full' : 'quick';
}

/**
 * ブラウザのチャンクが「どの段のつもりで送られたか」（状態と照合する申告。prd/14 §5.8）。
 *
 * 🔴 **再送しても変わらない値から読む。** 段を状態だけで決めると、quick の最後のチャンクを保存した後に
 * 応答だけが失われたとき、同じ本文の再送が（状態はもう quick 完了なので）full として扱われる
 * ——複数チャンクの棋譜では full の連続性で 400（web が棋譜の失敗として記録する）、1 チャンクの棋譜では
 * 100ms の結果が full として保存され出題まで作られる（レビュー OCL-35F059B0）。
 *
 * - 本文に `profile` があればそれ
 * - 無ければ（段を送らない 1 段のままの web）**`movetimeMs` から読む**。web は開始の口が返した
 *   `settings.movetimeMs` をそのまま載せるので、再送でも開始のときの段を指す。full の時間なら full、
 *   それ以外（quick の時間・2 段化の前の 300ms など）は quick——**知らない時間を full と読まない**
 */
export function browserClaimedProfile(body: {
  profile?: AnalysisProfile;
  movetimeMs: number;
}): AnalysisProfile {
  if (body.profile !== undefined) return body.profile;
  return body.movetimeMs === BROWSER_ANALYSIS_MOVETIME_MS.full ? 'full' : 'quick';
}

/**
 * 棋譜の指し方。worker の経路は内部の主キー、ログインの経路は所有者と番号（prd/14 §4.4）。
 * 🔒 ログインの経路は必ず後者で指す（所有者の条件が入る。他人の番号は「無い」）
 */
export type KifuTarget = { id: number } | { ownerId: string; no: number };

function targetWhere(target: KifuTarget) {
  return 'id' in target
    ? eq(kifus.id, target.id)
    : and(eq(kifus.ownerId, target.ownerId), eq(kifus.displayNo, target.no));
}

/** ユーザーの今の担当。行が無ければ null */
export async function analysisAssigneeOf(tx: Tx, userId: string): Promise<AnalysisAssignee | null> {
  const [row] = await tx
    .select({ assignee: users.analysisAssignee })
    .from(users)
    .where(eq(users.id, userId));
  return row?.assignee ?? null;
}

/** `worker` を担当に選べるか。🔒 手元 worker は所有者専用（prd/14 §1・§5.7。DB の CHECK も同じことを守る） */
export function canChooseWorker(userId: string): boolean {
  return userId === OWNER_USER_ID;
}

// --- チャンクの報告 ---

export interface ChunkSubmission {
  /** 報告する側が掴んでいる世代（取得・開始のときの `analysisRevision`） */
  revision: number;
  /** 報告する側。**棋譜の所有者の今の担当と違えば破棄する**（prd/14 §5.7 規則 2） */
  assignee: AnalysisAssignee;
  /**
   * 今回の submit の来歴（時刻は server が tx の時刻で付ける）。
   * `profile` は、手元 worker は自分の段をそのまま渡す。🔒 ブラウザは `'by-state'` を渡し、
   * **棋譜の行ロックの下で棋譜の状態から段を決める**（{@link browserStageOf}。prd/14 §5.8）
   */
  run: Omit<AnalysisRun, 'at' | 'profile'> & { profile: AnalysisProfile | 'by-state' };
  /**
   * `profile: 'by-state'` のとき、報告する側が申告した段（任意）。**状態から決めた段と違えば破棄する**
   * （quick の途中に届いた full・full の途中に届いた quick。prd/14 §5.8）。無ければ状態の段で受ける
   */
  claimedProfile?: AnalysisProfile;
  analyses: { moveNumber: number; candidates: CandidateInput[] }[];
  /**
   * 指定すると、**届いた段と同じ段の行の来歴がこのエンジンと違えば破棄する**（ブラウザ解析の受け口が渡す。prd/14 §5.9）。
   * ほかの段の行（完了した quick・手元 worker の quick）とは照合しない——full が quick を上書きしていく間の混在は許す。
   * やり直しの判定は開始の口が行うが、開始を通さない報告（別のタブ・別の端末が同じ世代を掴んだまま、
   * 配信物の更新の前後で別のビルドを動かしている）で 1 つの解析に別のエンジンの結果が混ざるのを止める。
   * 破棄された側は開始からやり直し、そこで行が消えて世代が進む。手元 worker の経路は渡さない（prd/05 §1.1d）
   */
  sameEngine?: { engineBuild: string; evalHash: string };
}

export type ChunkOutcome =
  /** 棋譜が無い（ログインの経路では他人の番号も同じ） */
  | { status: 'not-found' }
  /** 破棄した: 古い世代・担当違い・失敗の記録あり・その段階は完了済み・（ブラウザ）入っている解析と別のエンジン */
  | { status: 'ignored' }
  /** `moveNumber` が棋譜の手数を超えている → 400 */
  | { status: 'out-of-range' }
  /** 局面が連続していない・受理条件の先頭を越えた（prd/16 §4.2）→ 400 */
  | { status: 'not-contiguous' }
  /**
   * 受理した。`completed` は**報告された段階**が揃ったか・`profile` は受けた段。
   * `fullCompleted` は full まで揃ったか（解析全体の完了。ブラウザの受け口が返す）
   */
  | { status: 'applied'; completed: boolean; profile: AnalysisProfile; fullCompleted: boolean };

/**
 * チャンクを 1 つ受ける（prd/05 §1.1c・prd/16 §4）。呼び出し側のトランザクションの中で呼ぶ。
 *
 * 取得時と同一世代のときだけ適用する（reanalyze・担当の切り替え・開始の口のやり直しの後に届いた
 * 旧解析のチャンクは破棄）。`FOR UPDATE` で棋譜の行をロックし、それらと直列化する
 * （確認〜完了の更新の間に世代が進むのを防ぐ。どれも棋譜の行を先にロックするのでデッドロックしない）。
 */
export async function submitAnalysisChunk(
  tx: Tx,
  target: KifuTarget,
  { revision, assignee, run: runInput, claimedProfile, analyses, sameEngine }: ChunkSubmission,
): Promise<ChunkOutcome> {
  const [current] = await tx
    .select({
      id: kifus.id,
      revision: kifus.analysisRevision,
      error: kifus.analysisError,
      completedAt: kifus.analysisCompletedAt,
      analysisProfile: kifus.analysisProfile,
      usiMoves: kifus.usiMoves,
      ownerId: kifus.ownerId,
      // 今回の run の時刻（prd/16 §3.1）。トランザクションの時刻なので 1 回の submit の中で揃う。
      // ⚠ `sql` 断片の日時はオフセット付きの文字列で返る（列の変換を通らない）
      now: sql<string>`now()`.mapWith((v: string) => new Date(v).toISOString()),
    })
    .from(kifus)
    .where(targetWhere(target))
    .for('update');
  if (!current) return { status: 'not-found' };
  // 段を決める。ブラウザは棋譜の状態から（行ロックの下で読むので、開始の口と同じ段になる）。
  // 申告された段と違えば破棄——quick の途中の full は full の連続性で 400 になり、full の途中の quick は
  // 完了済みの段への報告で、どちらも報告する側が状態を取り違えている（開始からやり直せば正しい段になる）
  const profile: AnalysisProfile =
    runInput.profile === 'by-state' ? browserStageOf(current) : runInput.profile;
  if (claimedProfile !== undefined && claimedProfile !== profile) return { status: 'ignored' };
  const run: Omit<AnalysisRun, 'at'> = { ...runInput, profile };
  // 同一世代 かつ 失敗記録なし かつ **その段階が未完了** のときだけ適用。既に error が
  // 立っていれば結果は保存しない（行ロック下で error 報告と直列化する）。
  // 完了済みも弾く＝完了後の解析結果は不変（遅れて届いたチャンクで部分的に上書きされない）。
  // ⚠ **完了の判定は段階ごと**（prd/05 §1.1d）——full 完了済みへのチャンクは破棄し、
  // quick 完了済みの棋譜への full チャンクは受理する。`analysisCompletedAt` と
  // `analysisError` の排他は**意図して緩めた**（quick 完了 + full 失敗で両方が非 null）
  if (!isChunkAcceptable(current, revision, profile)) return { status: 'ignored' };
  // 🔒 **今の担当の報告だけを受ける**（prd/14 §5.7 規則 2）。棋譜の行ロックの下で読むので、
  // 切り替え（棋譜の行をロックして世代を進める）とは直列になる。
  // ⚠ 担当違いは「破棄」であって 4xx にしない——手元 worker は 4xx を恒久失敗として記録する
  if ((await analysisAssigneeOf(tx, current.ownerId)) !== assignee) return { status: 'ignored' };
  // 有効範囲（0..usiMoves.length）を保証してはじめて「件数 = 揃った局面数」が成り立つ。
  // 棋譜の手数を超える moveNumber が入ると、必要な局面が欠けたまま件数だけが達して完了扱いになりうる
  // （完了すると取得の対象から外れ、自動再開でも直らない）。範囲外は書かずに 400 で返す
  if (!isChunkInRange(analyses, current.usiMoves)) return { status: 'out-of-range' };
  // チャンクは**重ねる**（DELETE しない）。行を消すのは `reanalyze`（と動画棋譜の差し替え）・
  // 開始の口のやり直し・担当の切り替えだけ（prd/16 §4.3）。重なり・段階の後退防止・full の連続性は
  // `mergeChunk` が決める（prd/16 §4）
  const stored = await loadAnalysis(tx, current.id, { forUpdate: true });
  if (sameEngine && needsRestart(runsOfStage(stored.runs, profile), sameEngine)) {
    return { status: 'ignored' };
  }
  const merged = mergeChunk(stored, analyses, { ...run, at: current.now });
  if (!merged.ok) return { status: 'not-contiguous' };
  if (merged.wrote) {
    await saveAnalysis(tx, { id: current.id, ownerId: current.ownerId }, merged.next);
  }

  // 完了は **server が局面数で判定**する（報告する側の申告に依らない。prd/05 §1.1c）。
  // ⚠ **段階ごとに数える**（prd/05 §1.1d）: quick = `detail` の長さ / full = `fullCount`
  const quickDone = isAnalysisComplete(merged.next.detail.length, current.usiMoves);
  const fullDone = isAnalysisComplete(merged.next.fullCount, current.usiMoves);
  const profileAfter = nextKifuProfile(current.analysisProfile, {
    quick: quickDone,
    full: fullDone,
  });
  // 🔴 **full が揃った時点で出題を生成する**（prd/13 §8）。quick では作らない
  // ——出題の答えが探索の浅さで揺れると問題として成立しない（prd/13 §2）。
  // upsert なので、既に解いた問題の履歴は再生成でも消えない（prd/13 §6.1）。
  // ブラウザの full の完了もここを通る（経路を分けない。prd/14 §5.7）。
  // ⚠ 出題の行は RLS の下の tx でも書ける（所有者の写しを入れるので WITH CHECK を通る）
  if (fullDone) await syncDrills(tx, current.id, drillConfigFromEnv());
  if (profileAfter !== current.analysisProfile) {
    await tx
      .update(kifus)
      .set({
        analysisProfile: profileAfter,
        // `analysisCompletedAt` は「**初めて**全局面が揃った時刻」（prd/05 §1.1d）。
        // 既に立っていれば触らない（full 完了で上書きしない）
        ...(current.completedAt === null && (quickDone || fullDone)
          ? { analysisCompletedAt: new Date() }
          : {}),
      })
      .where(eq(kifus.id, current.id));
  }
  // 「解析中」の表示を落とすのは**報告された段階**が終わったとき（full 進行中に quick の
  // 完了で落とすと、まだ動いている解析の表示が消える）
  return {
    status: 'applied',
    completed: profile === 'full' ? fullDone : quickDone,
    profile,
    fullCompleted: fullDone,
  };
}

// --- 失敗の記録 ---

/**
 * 解析の失敗を記録する（`analysisError`。prd/05 §1.1a）。棋譜が無ければ null。
 *
 * 記録するのは、同一世代 かつ **報告する側の最終段（`stage`）が未完了** かつ 今の担当の報告のときだけ。
 * - 手元 worker は `stage: 'full'`。🔴 **`analysisCompletedAt IS NULL` では読まない**（prd/03 §2）。
 *   それは quick 完了で立つので、条件に使うと **quick 完了後の full の失敗を記録できない**
 *   （失敗した棋譜が永久に poll され続ける）。帰結として `analysisCompletedAt` と `analysisError` の
 *   排他は緩む（quick 完了 + full 失敗で両方が非 null。UI は quick の結果を見せたまま失敗を示す。prd/05 §2.5）
 * - ブラウザも `stage: 'full'`（2 段。進行中の段の失敗として、full が未完了なら記録する。prd/14 §5.8）。
 *   full まで完了した棋譜に遅れて届いた失敗は記録しない
 *
 * 以前は単文の UPDATE（compare-and-set）だった。担当を読むために棋譜の行ロックへ揃えた
 * （切り替えと直列にする。prd/14 §5.7 規則 2）。
 */
export async function recordAnalysisFailure(
  tx: Tx,
  target: KifuTarget,
  input: { revision: number; error: string; assignee: AnalysisAssignee; stage: AnalysisProfile },
): Promise<{ applied: boolean } | null> {
  const [current] = await tx
    .select({
      id: kifus.id,
      revision: kifus.analysisRevision,
      completedAt: kifus.analysisCompletedAt,
      analysisProfile: kifus.analysisProfile,
      ownerId: kifus.ownerId,
    })
    .from(kifus)
    .where(targetWhere(target))
    .for('update');
  if (!current) return null;
  if (current.revision !== input.revision || isStageComplete(current, input.stage)) {
    return { applied: false };
  }
  if ((await analysisAssigneeOf(tx, current.ownerId)) !== input.assignee) return { applied: false };
  await tx.update(kifus).set({ analysisError: input.error }).where(eq(kifus.id, current.id));
  return { applied: true };
}

// --- ブラウザ解析の開始 ---

/**
 * 来歴のうち、ある段の行が指すもの（prd/14 §5.9「照合の対象を進行中の段の行に絞る」）。
 *
 * 局面を指されなくなった run は `compactRuns` が落とすので、`profile` が段と同じ run が
 * そのまま「その段の行の来歴」になる。full の局面は先頭からの連続区間（`fullCount`）で、
 * quick の run は `fullCount` より前を書かない（`mergeChunk`）。
 */
export function runsOfStage<T extends Pick<AnalysisRun, 'profile'>>(
  runs: T[],
  stage: AnalysisProfile,
): T[] {
  return runs.filter((run) => run.profile === stage);
}

/**
 * 途中の解析を先頭からやり直すか（prd/14 §5.9）。
 *
 * 🔒 **来歴のどれかが、今のエンジンのビルドか評価関数と違えばやり直す**（項目を持たない run ＝
 * 手元 worker や項目を足す前の解析も「違う」に数える）。1 つの棋譜の中で別のエンジンの結果を混ぜないため。
 * 端末・スレッド数・置換表の違いは見ない（記録するだけ）。
 * ⚠ 呼ぶのは**未完了の解析**についてだけ。完了済みは不変で、ここを通さない。
 * 2 段では、渡す来歴を**進行中の段の行**に絞る（{@link runsOfStage}・{@link browserRestartNeeded}）
 */
export function needsRestart(
  runs: Pick<AnalysisRun, 'engineBuild' | 'evalHash'>[],
  engine: { engineBuild: string; evalHash: string },
): boolean {
  return runs.some(
    (run) => run.engineBuild !== engine.engineBuild || run.evalHash !== engine.evalHash,
  );
}

export type BrowserStart =
  /** 担当が `browser` でない → 409 */
  | { status: 'wrong-assignee' }
  /** 指し手列が無い（パースできなかった・平手でない）。解析の対象にならない */
  | { status: 'unanalyzable' }
  /** 解析済み（**full まで完了**。担当によらず full で完了。prd/14 §5.7）。何もしない */
  | { status: 'complete' }
  /** 失敗の記録がある。やり直すのは再解析（`reanalyze`）だけ */
  | { status: 'failed' }
  | {
      status: 'run';
      /** この世代で報告する。違う世代の報告は破棄される */
      revision: number;
      /** 回す段（quick → full。server が棋譜の状態から決める） */
      profile: AnalysisProfile;
      /** その段の再開位置（この `moveNumber` から解析する。quick は入っている局面数・full は `fullCount`） */
      startMoveNumber: number;
      /** 🔒 **世代と同じ tx で読んだ指し手列**（`reanalyze` は指し手列を作り直すので、別に読むと世代とずれうる） */
      usiMoves: string[];
      /** その段の設定（`movetimeMs` はその段の思考時間） */
      settings: BrowserStageSettings;
    };

/** 開始の口が、入っている解析をどう扱うか（{@link planBrowserStart}） */
export type BrowserStartPlan =
  /** そのまま続ける */
  | { action: 'continue'; profile: AnalysisProfile; startMoveNumber: number }
  /** 行を消して世代を進め、quick の 0 局面目から作り直す */
  | { action: 'restart' };

/**
 * 開始の口の判断（prd/14 §5.8・§5.9）。full まで完了した棋譜・失敗の記録がある棋譜は呼び出し側が先に除く。
 *
 * 🔒 **来歴の照合は進行中の段の行に絞る**（§5.9）:
 * - **quick の途中**: 今と同じく、入っている来歴のどれかがエンジンと違えばやり直す
 * - **full の開始**（quick が完了・full が 0 局面）: 照合しない。完了した quick はエンジンが違っても引き継ぐ
 *   （手元 worker の quick の上・配信物の更新の前の quick の上に full を重ねていく）
 * - **full の途中**: full の行の来歴が違えばやり直す。full の途中ぶんだけを取り除いて quick に戻すことはできない
 *   （full が quick を上書きしている）ので、全消去して quick から
 */
export function planBrowserStart(
  kifu: { completedAt: Date | null; analysisProfile: AnalysisProfile | null },
  stored: { detail: unknown[]; runs: Pick<AnalysisRun, 'profile' | 'engineBuild' | 'evalHash'>[]; fullCount: number },
  engine: { engineBuild: string; evalHash: string },
): BrowserStartPlan {
  if (browserStageOf(kifu) === 'quick') {
    if (stored.detail.length === 0 || !needsRestart(stored.runs, engine)) {
      return { action: 'continue', profile: 'quick', startMoveNumber: stored.detail.length };
    }
    return { action: 'restart' };
  }
  if (stored.fullCount === 0 || !needsRestart(runsOfStage(stored.runs, 'full'), engine)) {
    return { action: 'continue', profile: 'full', startMoveNumber: stored.fullCount };
  }
  return { action: 'restart' };
}

/**
 * ブラウザ解析を始める（prd/14 §5.8・§5.9）。世代・段・その段の再開位置・設定を返す。棋譜が無ければ null。
 *
 * 段は棋譜の状態から決める: quick が未完了なら quick、quick が完了して full が未完了なら full（2 段。prd/14 §5.2）。
 * 🔒 **進行中の段の解析が別のエンジン（ビルド・評価関数）のものなら、行を消して世代を進める**（作り直し。
 * 続きに重ねない——消さずに 0 手目から送ると前の解析の末尾が残り、再開位置と完了の判定がそれを数える）。
 * 前の世代を掴んだ側の報告は世代の照合で破棄される。棋譜の行ロックの下で行う（prd/16 §4.3）。
 */
export async function startBrowserAnalysis(
  tx: Tx,
  ownerId: string,
  no: number,
  engine: { engineBuild: string; evalHash: string },
): Promise<BrowserStart | null> {
  const [current] = await tx
    .select({
      id: kifus.id,
      revision: kifus.analysisRevision,
      error: kifus.analysisError,
      completedAt: kifus.analysisCompletedAt,
      analysisProfile: kifus.analysisProfile,
      usiMoves: kifus.usiMoves,
    })
    .from(kifus)
    .where(targetWhere({ ownerId, no }))
    .for('update');
  if (!current) return null;
  // 🔒 担当 `browser` のユーザーだけ（prd/14 §5.7 規則 2）。棋譜の行ロックの下で読む
  if ((await analysisAssigneeOf(tx, ownerId)) !== 'browser') return { status: 'wrong-assignee' };
  if (current.usiMoves === null) return { status: 'unanalyzable' };
  if (isStageComplete(current, 'full')) return { status: 'complete' };
  if (current.error !== null) return { status: 'failed' };

  const run = (revision: number, profile: AnalysisProfile, startMoveNumber: number): BrowserStart => ({
    status: 'run',
    revision,
    profile,
    startMoveNumber,
    usiMoves: current.usiMoves!,
    settings: browserAnalysisSettingsFor(profile),
  });

  const stored = await loadAnalysis(tx, current.id, { forUpdate: true });
  const plan = planBrowserStart(current, stored, engine);
  if (plan.action === 'continue') {
    return run(current.revision, plan.profile, plan.startMoveNumber);
  }
  await tx
    .delete(kifuAnalyses)
    .where(and(eq(kifuAnalyses.kifuId, current.id), eq(kifuAnalyses.ownerId, ownerId)));
  // 完了の印（quick の完了）も戻す: quick から作り直すので、残すと段の判定が full のままになる
  const [bumped] = await tx
    .update(kifus)
    .set({ ...ANALYSIS_STATE_RESET, analysisRevision: sql`${kifus.analysisRevision} + 1` })
    .where(and(eq(kifus.id, current.id), eq(kifus.ownerId, ownerId)))
    .returning({ revision: kifus.analysisRevision });
  return run(bumped.revision, 'quick', 0);
}

/**
 * ブラウザがバックグラウンドで解析する棋譜の番号（prd/14 §5.10「使用中は常に」）。
 *
 * full まで完了していない・失敗の記録なし・指し手列あり。**quick が未完了のものを先に**、
 * その中はそれぞれ新しい順（2 段の順序。手元 worker の「quick 待ちがあれば full を止める」と同じ考え方）。
 * ⚠ 一覧の `status=unanalyzed` は指し手列の無い棋譜も含むので流用しない（解析できない棋譜を取りに行き続ける）。
 * 担当が `browser` でなければ空（手元 worker の担当の棋譜をブラウザに渡さない）。
 */
export async function pendingBrowserKifuNos(tx: Tx, ownerId: string, limit: number): Promise<number[]> {
  if ((await analysisAssigneeOf(tx, ownerId)) !== 'browser') return [];
  // `isStageComplete(…, 'quick')` の否定（段階の記録も完了の時刻も無い）
  const quickPending = and(isNull(kifus.analysisProfile), isNull(kifus.analysisCompletedAt));
  const rows = await tx
    .select({ no: kifus.displayNo })
    .from(kifus)
    .where(
      and(
        eq(kifus.ownerId, ownerId),
        // `isStageComplete(…, 'full')` の否定
        or(isNull(kifus.analysisProfile), ne(kifus.analysisProfile, 'full')),
        isNull(kifus.analysisError),
        isNotNull(kifus.usiMoves),
      ),
    )
    .orderBy(
      sql`case when ${quickPending} then 0 else 1 end`,
      sql`coalesce(${kifus.playedAt}, ${kifus.createdAt}) desc`,
      desc(kifus.id),
    )
    .limit(limit);
  return rows.map((r) => r.no);
}

// --- 担当の切り替え ---

/** 切り替えで棋譜の解析をどうするか（prd/14 §5.7 規則 1） */
export type SwitchAction =
  /** 解析の行を消し、完了の印を戻して世代を進める（途中の解析） */
  | 'reset'
  /** 行は残し、世代だけ進める（quick が完了して full が 1 局面も入っていない） */
  | 'bump'
  /** 何もしない（full まで完了） */
  | 'keep';

/**
 * 担当の切り替えで、1 つの棋譜の解析をどうするか（prd/14 §5.7 規則 1・prd/16 §4.3）。
 *
 * 「途中」は次の 2 つで、どちらも行ごと消す（次に解析する側は 0 から始める）:
 * - **初めての完了の前**（quick の途中。quick を持たない worker なら full の途中）
 * - **quick は完了し、full が途中まで入っている**（`0 < fullCount`）。保存は局面ごとに 1 つで full が quick を
 *   上書きしているので、full の途中ぶんだけを取り除いて quick に戻すことはできない
 *
 * 🔒 **完了済みは不変**: full まで完了した棋譜には触れず、quick が完了した棋譜（full は 0 局面）は行を残す。
 */
export function classifyForSwitch(kifu: {
  completedAt: Date | null;
  analysisProfile: AnalysisProfile | null;
  /** full が入っている局面があるか（`kifuAnalyses.fullCount > 0`） */
  hasFull: boolean;
}): SwitchAction {
  if (kifu.analysisProfile === 'full') return 'keep';
  if (!isStageComplete(kifu, 'quick') || kifu.hasFull) return 'reset';
  return 'bump';
}

export type SwitchResult =
  /** `worker` は所有者だけ → 403 */
  | { status: 'forbidden' }
  /** ユーザーの行が無い */
  | { status: 'not-found' }
  /** 同じ値。🔒 **何もしない**（同じ値を送るたびに途中の解析を消さない） */
  | { status: 'unchanged'; assignee: AnalysisAssignee }
  | { status: 'switched'; assignee: AnalysisAssignee; reset: number; bumped: number };

/** `inArray` に渡す ID を分ける大きさ（1 文のパラメータ数を抑える） */
const ID_BATCH = 1000;

/**
 * 解析の担当を切り替える（prd/14 §5.7）。**設定の更新と同じ tx で**、そのユーザーの
 * 「full まで完了していない棋譜」すべての世代を進める（規則 1）。
 *
 * - 途中の棋譜は解析の行も消す（{@link classifyForSwitch}）。それ以外の未完了は世代だけ進める
 * - 🔒 世代を進める棋譜は `analysisError` も null に戻す——失敗は前の担当の進行中の段階のもの。
 *   残すと、quick 完了・full 失敗の棋譜で新しい担当が full を回さない（開始の口は失敗の記録があれば解析しない）
 * - 切り替え前に取得・開始していた側の報告は、世代の照合と担当の照合（規則 2）で破棄される。
 *   往復（`worker` → `browser` → `worker`）しても世代は戻らない
 * - 途中の棋譜は出題を持たない（出題は full の完了時だけ。prd/13 §8）ので、出題の作り直しは要らない
 *
 * ⚠ **`users` の行を先にロックしてから棋譜を取る。** 取り込み（`insertKifu`）も `users` の行を先に取るので、
 * 切り替えの途中に生まれる棋譜を取りこぼさない（取り込みは切り替えのコミットを待ち、新しい担当の下で始まる）。
 * 呼び出し側はコミットの後に `clearProgressForOwner` で「解析中」の表示を落とす。
 */
export async function switchAnalysisAssignee(
  tx: Tx,
  userId: string,
  next: AnalysisAssignee,
): Promise<SwitchResult> {
  if (next === 'worker' && !canChooseWorker(userId)) return { status: 'forbidden' };
  const [user] = await tx
    .select({ assignee: users.analysisAssignee })
    .from(users)
    .where(eq(users.id, userId))
    .for('update');
  if (!user) return { status: 'not-found' };
  if (user.assignee === next) return { status: 'unchanged', assignee: next };
  await tx.update(users).set({ analysisAssignee: next }).where(eq(users.id, userId));

  // full まで完了していない棋譜を、決まった順（id 昇順）でロックする。
  // ⚠ ロックを待つ間に報告が full を完了させた棋譜は、ロックの後の再評価でこの条件から外れる
  const targets = await tx
    .select({
      id: kifus.id,
      completedAt: kifus.analysisCompletedAt,
      analysisProfile: kifus.analysisProfile,
    })
    .from(kifus)
    .where(
      and(
        eq(kifus.ownerId, userId),
        or(isNull(kifus.analysisProfile), ne(kifus.analysisProfile, 'full')),
      ),
    )
    .orderBy(asc(kifus.id))
    .for('update');
  // 🔒 **棋譜の行ロックを取った後で**解析の行を読む（報告は棋譜の行ロックの下でしか書かないので、
  // ここで読む `fullCount` は切り替えのコミットまで変わらない）
  const withFull = new Set(
    (
      await tx
        .select({ kifuId: kifuAnalyses.kifuId })
        .from(kifuAnalyses)
        .where(and(eq(kifuAnalyses.ownerId, userId), gt(kifuAnalyses.fullCount, 0)))
    ).map((r) => r.kifuId),
  );

  const resetIds: number[] = [];
  const bumpIds: number[] = [];
  for (const kifu of targets) {
    const action = classifyForSwitch({ ...kifu, hasFull: withFull.has(kifu.id) });
    if (action === 'reset') resetIds.push(kifu.id);
    else if (action === 'bump') bumpIds.push(kifu.id);
  }

  const nextRevision = sql`${kifus.analysisRevision} + 1`;
  for (let i = 0; i < resetIds.length; i += ID_BATCH) {
    const ids = resetIds.slice(i, i + ID_BATCH);
    // `reanalyze` と同じ全消去（prd/16 §4.3）。完了の印も 3 列そろえて戻す
    await tx
      .delete(kifuAnalyses)
      .where(and(eq(kifuAnalyses.ownerId, userId), inArray(kifuAnalyses.kifuId, ids)));
    await tx
      .update(kifus)
      .set({ ...ANALYSIS_STATE_RESET, analysisRevision: nextRevision })
      .where(and(eq(kifus.ownerId, userId), inArray(kifus.id, ids)));
  }
  for (let i = 0; i < bumpIds.length; i += ID_BATCH) {
    const ids = bumpIds.slice(i, i + ID_BATCH);
    await tx
      .update(kifus)
      .set({ analysisError: null, analysisRevision: nextRevision })
      .where(and(eq(kifus.ownerId, userId), inArray(kifus.id, ids)));
  }
  return { status: 'switched', assignee: next, reset: resetIds.length, bumped: bumpIds.length };
}
