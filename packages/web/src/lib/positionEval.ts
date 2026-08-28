/**
 * 検討局面の評価要求（prd/12 §2）。`POST /api/positions/evaluate` を叩く。
 *
 * 🔴 **POST は受け付けて即座に返り、結果は別のリクエストで取りに行く**（決定 2026-08-29。
 * prd/12 §2.4）。既存解析・キャッシュにあれば POST の 1 往復で結果まで返る（数十 ms）。
 * エンジンに回るときは `jobId` が返り、以後はポーリングで待つ（数秒〜十数秒）。
 * 待たせる以上 **中断できることが要件**なので `AbortSignal` を必ず受ける。押し直したら
 * 前の要求を abort する（二重送信の抑止は呼び出し側の状態機械が持つ。
 * 前例は `routes/positions.tsx` の 4 状態）。
 *
 * 🔒 **既存解析の再利用判定（prd/12 §2.6）は server の 1 か所にある。**
 * ここに同じ判定を持たせない。web は応答の `source` を**そのまま出す**だけ
 * （どこから来た値かを黙って混ぜない）。
 */
import type { BoardState, PositionViolation } from 'shared';
import { validateMoveOnPosition, validatePositionForEngine } from 'shared';
import { client } from './honoClient';
import type { EvalTarget } from './study';

/**
 * 評価要求の画面上の状態。**押されたときだけ動く**（前例: `routes/positions.tsx`）。
 *
 * 🔴 **`idle` と `stale` を分ける。** どちらも「評価値を出していない」状態だが、
 * ユーザから見た意味が違う:
 *
 * - `idle`: **まだ一度も評価していない**。手がかりは要らない（何も出さない）。
 * - `stale`: **評価したが、その後で局面が変わった**。値は消すが、
 *   「もう一度評価できる」ことを言う必要がある。
 *
 * 実機で踏んだ: 評価結果が出ている状態で駒を動かすと結果ブロックが**黙って消え**、
 * 「もう評価できないのか」と読めてしまった（機能としては押せる）。2 つを `idle` に
 * 畳んでいたのが原因。
 *
 * ⚠ **古い評価値そのもの（スコア・候補手・読み筋）は残さない。** グレーアウトして
 * 残す案も採らない——別の局面の値を画面に置くのは prd/12 §2.6 の
 * 「値の出所を黙って混ぜない」に反する。出すのは手がかりだけ。
 */
export type EvalState =
  | { kind: 'idle' }
  | { kind: 'stale' }
  | { kind: 'loading' }
  | {
      kind: 'done';
      /** 評価した局面（= 現在の検討局面） */
      base: BoardState;
      candidates: EvalCandidateView[];
      source: EvalSource;
      /**
       * 直前の手の採点（{@link gradeLastMove}）。取れなかったときは null
       * （直前が編集 / 1 手前の評価が失敗・busy・abort）。
       * 🔒 **主の局面評価はこれが null でも必ず出す。**
       */
      grade: MoveGrade | null;
    }
  | { kind: 'invalid'; violations: PositionViolation[] }
  | { kind: 'busy' }
  | { kind: 'error'; message: string };

/**
 * 局面が変わったときの遷移。
 *
 * **一度でも評価に触れていれば `stale`**（結果・検証エラー・キュー満杯・失敗・待ち中の
 * いずれも「評価しようとした」状態なので、盤が変わったことを言う値がある）。
 * まだ何もしていない `idle` はそのまま。
 *
 * ⚠ 変化が無いときは**同じオブジェクトを返す**（無駄な再描画を作らない）。
 */
export function evalStateAfterPositionChange(prev: EvalState): EvalState {
  if (prev.kind === 'idle' || prev.kind === 'stale') return prev;
  return { kind: 'stale' };
}

/** 候補手 1 本（server の `EvalCandidate`。スコアは**手番側から見た値**） */
export interface EvalCandidateView {
  rank: number;
  move: string;
  scoreType: string;
  scoreValue: number;
  pv: string[];
  depth: number;
}

/**
 * 「この局面の評価値」として単独で出す 1 本を選ぶ。
 *
 * 🔴 **実機で踏んだ**: 局面評価は候補手 3 本を返すが、**その局面自体の評価値が
 * 単独では出ていなかった**。最善手のスコアがそのまま局面の評価値なのに、候補手リストの
 * 1 行目に埋もれていて「評価値が 1 つ決まるはずなのに、どこにも無い」と読めた。
 * 棋譜を見ているときは情報行に評価値が 1 つ出る（prd/05 §2.1）ので、
 * **同じ画面の中で扱いが食い違っていた**のも良くない。
 *
 * rank 1 の候補手のスコアが、そのままその局面の評価値になる。
 *
 * ⚠ **rank の一番小さいものを選ぶ**（配列の並びに頼らない）。候補が空（詰みなど）なら null。
 */
export function headlineCandidate(
  candidates: EvalCandidateView[],
): EvalCandidateView | null {
  let best: EvalCandidateView | null = null;
  for (const candidate of candidates) {
    if (best === null || candidate.rank < best.rank) best = candidate;
  }
  return best;
}

/** 値の出所（prd/12 §2.6）。UI に必ず出す */
export type EvalSource = 'kifu' | 'engine';

/**
 * 直前の手の採点（prd/12 §3.2・決定 2026-08-29）。
 *
 * 🔴 **web の評価ボタンは 1 つ**になった。押すと現在の検討局面を評価し、**直前が盤上の
 * 指し手なら 1 手前の局面も並行して評価**して、その手が最善手とどれだけ離れていたかを出す。
 * かつての「この手を読む」（名指し評価 = `go searchmoves`）は、返る数字が局面評価と
 * **同じで符号だけ反転**していたため web からは外した（API には残る。prd/12 §2.2 / §4）。
 *
 * ⚠ **スコアはすべて「指した側から見た値」に揃える**（現局面の評価は相手番視点なので反転する）。
 */
export interface MoveGrade {
  /** 採点した手を**指す前**の局面。表記（`usiToJapaneseWithPiece`）と視点の基点 */
  from: BoardState;
  /** 採点した手（USI） */
  move: string;
  /** 指した手の評価値（**指した側視点**。現局面の評価の符号反転） */
  playedScoreType: string;
  playedScoreValue: number;
  /** 1 手前の局面の rank 1（指した側視点。`from` の手番から見た値がそのまま使える） */
  best: EvalCandidateView;
  /** 指した手が最善手そのものだったか */
  isBest: boolean;
  /**
   * 損失 = 最善のスコア − 指した手のスコア。
   * 🔒 **両方 `cp` のときだけ数値**。どちらかが `mate` なら null（引き算が意味を持たない）。
   */
  loss: number | null;
  /**
   * **1 手前の局面の評価**の出所（= `best` がどこから来たか。prd/12 §2.6）。
   * ⚠ 主の局面評価とは**別の要求**なので、片方だけ `kifu` ということが起きる。
   * 🔒 `playedScoreValue` はこの出所ではない——**主の評価の符号反転**なので、
   * 出所は結果ヘッダーのバッジの方。表示でこの 2 つを取り違えないこと（決定 2026-08-29）。
   */
  source: EvalSource;
}

/**
 * 損失（centipawn）。**両方 `cp` のときだけ数値を返す**。
 *
 * 🔴 `mate` の値は「詰みまでの手数」で、`cp` と単位が違うし `mate` 同士でも引き算に
 * 意味が無い（`mate 3` − `mate 5` は 2 点差ではない）。**数値を出さず両者を並べる**方を採る。
 *
 * ⚠ 符号は「最善 − 指した手」なので通常は 0 以上だが、2 回の探索は別々（深さも別）なので
 * **わずかに負になることがある**。丸めずそのまま返す（表示側が読み替えない）。
 */
export function scoreLoss(
  best: { scoreType: string; scoreValue: number },
  played: { scoreType: string; scoreValue: number },
): number | null {
  if (best.scoreType !== 'cp' || played.scoreType !== 'cp') return null;
  return best.scoreValue - played.scoreValue;
}

/**
 * 直前の手を採点する。**評価値そのものは 2 つの応答から作る**:
 *
 * - 指した手の評価値 = **現局面（手を指した後）の評価値の符号反転**。現局面の評価は
 *   相手番視点なので、反転すれば「指した側から見た、その手を指した結果」になる。
 * - 最善 = **1 手前の局面**の rank 1（`from` の手番 = 指した側の視点なのでそのまま）。
 *
 * ⚠ 材料が欠けたら null を返す（候補手が空 / 現局面の評価値が無い）。
 * 🔒 **null は「採点が出ない」だけで、主の局面評価は必ず出す**（呼び出し側の責務）。
 */
export function gradeLastMove(params: {
  from: BoardState;
  move: string;
  /** 現局面（手を指した後）の評価値。相手番視点 */
  current: EvalCandidateView | null;
  /** 1 手前の局面の候補手（指した側視点） */
  previousCandidates: EvalCandidateView[];
  previousSource: EvalSource;
}): MoveGrade | null {
  const { from, move, current, previousCandidates, previousSource } = params;
  if (current === null) return null;
  const best = headlineCandidate(previousCandidates);
  if (best === null) return null;

  // 🔴 符号反転はここだけ。相手番視点 → 指した側視点
  const played = { scoreType: current.scoreType, scoreValue: -current.scoreValue };
  return {
    from,
    move,
    playedScoreType: played.scoreType,
    playedScoreValue: played.scoreValue,
    best,
    isBest: best.move === move,
    loss: scoreLoss(best, played),
    source: previousSource,
  };
}

export type EvalResult =
  | {
      kind: 'done';
      candidates: EvalCandidateView[];
      source: EvalSource;
      /** 名指し評価を「手を適用した局面の符号反転」で求めたか（prd/12 §2.2） */
      fallback: boolean;
      evaluatedAt: string;
    }
  /** 局面・指し手が検証で弾かれた（クライアント検証 / server の 400 の両方が来る） */
  | { kind: 'invalid'; violations: PositionViolation[] }
  /** キューが一杯（503）。worker が止まっている疑い */
  | { kind: 'busy' }
  /** 呼び出し側が abort した。**画面には何も出さない**（押し直しの合図） */
  | { kind: 'aborted' }
  /** ジョブが失敗した / 通信できなかった */
  | { kind: 'failed'; message: string };

/**
 * 送る前にクライアント側で検証する（prd/12 §2.5 の検証は `shared` の 1 つ）。
 * **往復を減らすため**で、server 側の検証を省く話ではない（server も同じ関数を通す）。
 *
 * ⚠ 名指し評価の `state` は**その手を指す前の局面**（`namedEvalTarget` が返す SFEN の元）。
 */
export function validateEvalTarget(
  state: BoardState,
  move: string | null,
): PositionViolation[] {
  const position = validatePositionForEngine(state);
  const violations = position.ok ? [] : [...position.violations];
  if (move !== null) {
    const checked = validateMoveOnPosition(state, move);
    if (!checked.ok) violations.push(...checked.violations);
  }
  return violations;
}

/** 応答の形（Hono RPC の union をここで 1 度だけ受け止める） */
interface EvaluateResponse {
  status?: 'done' | 'failed' | 'pending';
  /** `status: 'pending'` のとき、結果を取りに行くための ID */
  jobId?: string;
  candidates?: EvalCandidateView[];
  source?: EvalSource;
  fallback?: boolean;
  evaluatedAt?: string;
  error?: string;
  violations?: PositionViolation[];
}

/**
 * 結果を取りに行く間隔（ミリ秒）。
 *
 * エンジン評価は数秒〜十数秒かかる（prd/12 §2.4）。1 秒なら**表示の遅れが体感に乗らず**、
 * 総予算いっぱい待っても要求は 240 本程度で済む。GET 側は server のメモリを引くだけなので、
 * この頻度で叩いても仕事は増えない。⚠ これより短くしても**エンジンは速くならない**。
 */
export const EVAL_POLL_INTERVAL_MS = 1_000;

/**
 * 評価 1 回（＝ユーザーの 1 押し）に許す総時間（ミリ秒）。
 *
 * 🔒 **server 側の期限に合わせる**（`DEFAULT_QUEUE_TIMEOUT_MS` 120 秒 +
 * `DEFAULT_RUN_TIMEOUT_MS` 120 秒 = 最大 240 秒）。server が諦めた後まで取りに行っても
 * 意味が無いので、ここで切って素直に失敗を出す。
 */
export const EVAL_TOTAL_BUDGET_MS = 240_000;

/**
 * HTTP 1 本に許す時間（ミリ秒）。
 *
 * 🔴 **これは long-poll の待ち時間ではない。** POST も GET も server 側は即答するので、
 * ここに引っかかるのは**通信が固まったとき**だけ。前段（リバースプロキシ / Cloudflare）の
 * タイムアウトより十分短くしてあるが、**そもそも前段の期限に依存しない形にした**のが
 * 非同期化の目的で、この値は固まった 1 本を捨てて次へ進むための保険。
 */
export const EVAL_REQUEST_TIMEOUT_MS = 20_000;

/** `requestPositionEval` が使う HTTP の口（テストで差し替えられるように切り出す） */
export interface EvalHttpResponse {
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
}
export interface EvalHttp {
  /** 評価を要求する。結果が出ていれば結果、出ていなければ `pending` + `jobId` */
  post(target: EvalTarget, signal: AbortSignal): Promise<EvalHttpResponse>;
  /** `jobId` で結果を取りに行く */
  get(jobId: string, signal: AbortSignal): Promise<EvalHttpResponse>;
}

/**
 * 本文を JSON として読む。**読めなければ null**（例外にしない）。
 *
 * 🔴 **実機で踏んだ**: 前段が返すエラーページ（504 の HTML）で `res.json()` が落ちて
 * `catch` に入り、**すべて「サーバーに接続できません」**になっていた。ステータスに応じた
 * 文言（`サーバーエラー (504)`）が出ず、**原因が画面から分からなかった**。
 * 非同期化で 504 の経路は細くなるが、前段が HTML を返すこと自体は無くならない。
 *
 * ⚠ **abort だけは投げ直す。** 本文の受信中に中断されたときまで「読み取れなかった」に
 * 畳むと、呼び出し側の中断・自前の打ち切りと区別できなくなる。
 */
async function readEvalBody(res: EvalHttpResponse): Promise<EvaluateResponse | null> {
  try {
    return (await res.json()) as EvaluateResponse;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    return null;
  }
}

/** 応答 1 本の読み取り結果。`EvalResult` に畳めないものだけ別の形にする */
type EvalStep =
  | EvalResult
  /** 受け付けられた（結果はまだ）。`jobId` で取りに行く */
  | { kind: 'pending'; jobId: string | null }
  /** その `jobId` はもう取れない（TTL 切れ / server 再起動）。**投げ直す** */
  | { kind: 'gone' };

/**
 * 応答 1 本を読む。**本文のパースはステータス判定より後ろ**（上記の 504）。
 *
 * @param polling ポーリング（GET）の応答か。404 の意味が POST とは違う
 */
async function interpretEvalResponse(
  res: EvalHttpResponse,
  polling: boolean,
): Promise<EvalStep> {
  if (res.status === 400) {
    const body = await readEvalBody(res);
    return { kind: 'invalid', violations: body?.violations ?? [] };
  }
  if (res.status === 503) return { kind: 'busy' };
  // 🔒 ポーリング中の 404 は「まだ出ていない」ではなく「**もう取れない**」。投げ直す
  if (polling && res.status === 404) return { kind: 'gone' };
  if (!res.ok && res.status !== 202) {
    return { kind: 'failed', message: `サーバーエラー (${res.status})` };
  }
  const body = await readEvalBody(res);
  if (body === null) {
    return { kind: 'failed', message: '応答を読み取れませんでした' };
  }
  if (body.status === 'pending') {
    return { kind: 'pending', jobId: body.jobId ?? null };
  }
  if (body.status === 'failed') {
    return { kind: 'failed', message: body.error ?? '評価に失敗しました' };
  }
  return {
    kind: 'done',
    candidates: body.candidates ?? [],
    source: body.source ?? 'engine',
    fallback: body.fallback ?? false,
    evaluatedAt: body.evaluatedAt ?? '',
  };
}

/** HTTP 1 本の顛末。**「自分で打ち切った」を型で分ける** */
type Attempt =
  | { kind: 'step'; step: EvalStep }
  /** 自前の期限で畳んだ（固まった 1 本） */
  | { kind: 'cut-off' }
  /** 呼び出し側が中断した */
  | { kind: 'aborted' }
  | { kind: 'network-error' };

/**
 * HTTP を 1 本投げて読む。
 *
 * 🔴 **`AbortError` かどうかで「誰が止めたか」を判断しない。** 自前の打ち切りも
 * 呼び出し側の中断も本物の通信断も、区別できない形で例外になる（⚠ `AbortSignal.timeout()`
 * に至っては `TimeoutError` を投げるので、素朴に使うと「サーバーに接続できません」になる）。
 * **打ち切ったことをフラグで持つ**。
 *
 * 🔴 **`EvalRequestTracker.begin()` はここでは呼ばない。** `begin()` は `cancel()` 経由で
 * 世代を進めるので、ポーリングのたびに呼ぶと**同時に走っている採点用の副次要求を自分で
 * 捨ててしまう**。per-attempt の `AbortController` を内部に持ち、外から渡される `signal` は
 * 「呼び出し側による中断」の伝播だけに使う。
 */
async function sendEval(
  call: (signal: AbortSignal) => Promise<EvalHttpResponse>,
  outer: AbortSignal,
  polling: boolean,
  timeoutMs: number,
): Promise<Attempt> {
  const controller = new AbortController();
  /** **自分で打ち切ったか。** `AbortError` では区別できない */
  let cutOff = false;
  const forward = () => controller.abort();
  outer.addEventListener('abort', forward, { once: true });
  const timer = setTimeout(() => {
    cutOff = true;
    controller.abort();
  }, timeoutMs);
  try {
    const res = await call(controller.signal);
    return { kind: 'step', step: await interpretEvalResponse(res, polling) };
  } catch (err) {
    // 呼び出し側の中断が最優先。**画面にエラーを出さない**合図
    if (outer.aborted) return { kind: 'aborted' };
    if (cutOff) return { kind: 'cut-off' };
    if (err instanceof Error && err.name === 'AbortError') return { kind: 'aborted' };
    // ここまで来たものだけが**本物の通信断**
    return { kind: 'network-error' };
  } finally {
    clearTimeout(timer);
    outer.removeEventListener('abort', forward);
  }
}

/** 中断できる待ち（abort されたら即座に起きる） */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * 評価を要求して結果を取りに行く。**例外は投げない**（すべて `EvalResult` に畳む）。
 *
 * 🔴 **POST は待たない**（決定 2026-08-29。prd/12 §2.4）。server はキャッシュ・棋譜解析から
 * 引ければその場で結果を返し（**棋譜をなぞっている間は 1 往復のまま**）、エンジンに回すときは
 * `jobId` だけを返す。以後は {@link EVAL_POLL_INTERVAL_MS} ごとに取りに行く。
 * long-poll をやめたのは、**前段（リバースプロキシ / Cloudflare）のタイムアウトが server の
 * 期限よりずっと短く、成功しているのに失敗して見える**事故が本番で起きたため。
 * 前段の設定値は分からず将来も変わるので、**そこに依存しない形にした**。
 *
 * 🔒 **状態は `loading` のまま。** ポーリングは呼び出し側から見えない（返るのは最終結果
 * だけ）ので、「評価しています」の表示は途切れない。
 *
 * ⚠ **ジョブが消えていたら（`gone`）投げ直す。** server のジョブとキャッシュはプロセスの
 * メモリにあり、再起動・TTL 切れで消える（prd/12 §2.4）。投げ直せばキャッシュ命中なら即答、
 * 無ければ改めてジョブになる——クライアントから見ると待ちが続くだけ。
 */
export async function requestPositionEvalWith(
  http: EvalHttp,
  target: EvalTarget,
  signal: AbortSignal,
  options: {
    pollIntervalMs?: number;
    totalBudgetMs?: number;
    requestTimeoutMs?: number;
    now?: () => number;
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  } = {},
): Promise<EvalResult> {
  const pollIntervalMs = options.pollIntervalMs ?? EVAL_POLL_INTERVAL_MS;
  const totalBudgetMs = options.totalBudgetMs ?? EVAL_TOTAL_BUDGET_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? EVAL_REQUEST_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? delay;
  const startedAt = now();

  /** null の間は POST（受け付けてもらう）、決まったら GET（取りに行く） */
  let jobId: string | null = null;

  for (;;) {
    if (signal.aborted) return { kind: 'aborted' };
    if (now() - startedAt >= totalBudgetMs) {
      return { kind: 'failed', message: '評価が時間内に終わりませんでした' };
    }

    const id: string | null = jobId;
    const attempt: Attempt =
      id === null
        ? await sendEval((s) => http.post(target, s), signal, false, requestTimeoutMs)
        : await sendEval((s) => http.get(id, s), signal, true, requestTimeoutMs);

    if (attempt.kind === 'aborted') return { kind: 'aborted' };
    if (attempt.kind === 'network-error') {
      return { kind: 'failed', message: 'サーバーに接続できません' };
    }
    if (attempt.kind === 'cut-off') {
      // 固まった 1 本を捨てただけ。総予算が残っていればそのまま続ける
      continue;
    }

    const step: EvalStep = attempt.step;
    if (step.kind === 'gone') {
      // ジョブが消えていた。**投げ直す**（キャッシュにあれば即答が返る）
      jobId = null;
      continue;
    }
    if (step.kind === 'pending') {
      if (step.jobId === null && jobId === null) {
        // 受け付けたと言われたのに取りに行く先が無い（server との食い違い）
        return { kind: 'failed', message: '評価の受付 ID が返りませんでした' };
      }
      jobId = step.jobId ?? jobId;
      await sleep(pollIntervalMs, signal);
      continue;
    }
    return step;
  }
}

const evalHttp: EvalHttp = {
  post: async (target, signal) => {
    const res = await client.api.positions.evaluate.$post(
      { json: { sfen: target.sfen, move: target.move } },
      { init: { signal } },
    );
    return { status: res.status, ok: res.ok, json: () => res.json() as Promise<unknown> };
  },
  get: async (jobId, signal) => {
    const res = await client.api.positions.evaluate[':jobId'].$get(
      { param: { jobId } },
      { init: { signal } },
    );
    return { status: res.status, ok: res.ok, json: () => res.json() as Promise<unknown> };
  },
};

/** 評価を要求して結果を待つ。**例外は投げない**（すべて `EvalResult` に畳む） */
export function requestPositionEval(
  target: EvalTarget,
  signal: AbortSignal,
): Promise<EvalResult> {
  return requestPositionEvalWith(evalHttp, target, signal);
}

/**
 * 走っている評価要求の**採否を決める**小さな番人。
 *
 * 🔴 **踏んだ不具合**（レビュー指摘 `OCL-AED22F46`）: 評価は数秒〜十数秒かかる
 * （既存解析に無い局面は必ずエンジン経由。今はポーリングで待つ）。その間に駒を動かすのはごく自然な操作だが、
 * 要求を捨てていなかったため**旧局面の応答が、編集後の盤の評価として表示された**。
 * 検討ツールとしては値の意味が壊れる。クライアント検証で弾いた警告を、後から届いた
 * 旧要求の結果が上書きする経路もあった。
 *
 * 🔒 **待っている間に盤を固める案は採らない。** prd/12 §3 は「駒を動かした時点で検討が
 * 始まる」「手送りしたら破棄」という自由な操作を前提にしており、待ちの間だけ盤が固まるのは
 * 体験として不自然。**要求の側を捨てる**（abort + 世代で無視）方を採る。
 *
 * 🔒 **abort だけに頼らない。** `AbortController` は fetch を止めるが、応答の受信と
 * abort が競れば**結果が手元まで届く**（`requestPositionEval` が `kind: 'done'` を
 * 返しきった後の abort は何も取り消さない）。世代（token）を進めて、
 * **反映してよいかを呼び出し側が明示的に判定する**。
 */
export class EvalRequestTracker {
  #controller: AbortController | null = null;
  #token = 0;

  /** 新しい要求を始める。前の要求はここで捨てられる（押し直し・二重送信の抑止） */
  begin(): { token: number; signal: AbortSignal } {
    this.cancel();
    const controller = new AbortController();
    this.#controller = controller;
    return { token: this.#token, signal: controller.signal };
  }

  /**
   * 走っている要求を捨てる。**局面が変わりうる操作のたびに呼ぶ**
   * （編集 / undo / 棋譜に戻る / 手送りによる破棄 / クライアント検証で弾いたとき）。
   * 走っていなくても呼んでよい（世代だけが進む）。
   */
  cancel(): void {
    this.#controller?.abort();
    this.#controller = null;
    this.#token += 1;
  }

  /** `begin` で受け取った token の結果を、今の画面へ反映してよいか */
  accepts(token: number): boolean {
    return token === this.#token;
  }
}
