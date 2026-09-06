// 解析の進捗表示（`GET /api/analysis/progress` の整形）。
//
// 進捗は N/M と「最終更新からの経過」を必ず組で出す。2 値の「解析中」だけでは worker が
// ハングしても「解析中」のままになり、**進捗が動くこと自体が生存確認になる**という利点が消える。
// 一方で「何分更新が無ければ死んでいる」の閾値は置かない。1 局面あたりの所要時間は
// エンジン構成（MATERIAL/NNUE・depth/byoyomi）で桁が変わり、根拠のある値を選べないため
// （prd/05-analysis.md §1.3・§2.5）。経過時間を出して判断は人に委ねる。

/** 解析の段階（prd/05 §1.1d）。**2 つ固定**で、名前に強さの順序を持たせる（quick < full） */
export type AnalysisProfile = 'quick' | 'full';

/** server のメモリ上の進捗（`packages/server/src/analysis-progress.ts` と対応） */
export interface AnalysisProgress {
  kifuId: number;
  revision: number;
  /**
   * 実行中の段階。**文字では出さず**、解析中スピナーの見え方（濃さ）の出し分けに使う
   * （prd/05 §2.5・決定 2026-09-05 後段）。
   */
  profile: AnalysisProfile;
  analyzed: number;
  total: number;
  updatedAt: string;
}

/**
 * 解析中の表示を段階で見分けるための不透明度クラス（prd/05 §2.5・決定 2026-09-05 後段）。
 *
 * 🔴 **段階は文字で出さない。** 簡易解析だけが終わっている状態は**直後に詳細解析が走る
 * 一時的な状態**で、そこに「簡易」の語を割くと、**主に使うモバイルで横幅を恒久的に食う**。
 * 見分けが要るのは「いま動いているのがどちらか」だけなので、**解析中のスピナーの濃さ**で示す
 * ——quick 進行中は半透明、full 進行中は通常。
 *
 * ⚠ **不透明度だけを変える**（大きさ・行の高さ・幅は 1px も動かさない）。
 */
export function progressDimClass(profile: AnalysisProfile): string {
  return profile === 'quick' ? 'opacity-50' : '';
}

/** 最終更新からの経過を日本語にする（分単位で読めればよいので秒は 1 分未満のみ） */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分前`;
  const hours = Math.floor(minutes / 60);
  return `${hours}時間${minutes % 60}分前`;
}

/** 「3分前に更新」。`updatedAt` が読めないときは空文字（経過を出さない） */
export function formatUpdatedAgo(
  progress: AnalysisProgress,
  now: number,
): string {
  const updatedAt = Date.parse(progress.updatedAt);
  if (Number.isNaN(updatedAt)) return '';
  return `${formatElapsed(now - updatedAt)}に更新`;
}

// ---------------------------------------------------------------------------
// 進捗の再取得間隔と、標本の間を埋める推定（決定・2026-09-07。prd/05 §2.5）
// ---------------------------------------------------------------------------

/**
 * 解析の完了を待っている間のポーリング間隔。
 *
 * 🔴 **「待っているか」はローダーのデータから導く**（未完了の棋譜が画面にあるか）。
 * 進捗エントリの出現・消滅という**エッジ**を粗いサンプリングで捉える設計だと、
 * 解析全体（本番の quick は 0.15 秒/局面 × 手数 ≒ 20 秒）が**2 回のポーリングの合間に
 * すっぽり収まり**、1 度も観測されずに画面が解析前のまま固まる（実測・2026-09-07）。
 * 進捗エンドポイントは server のメモリ参照だけで DB を触らないので、短間隔で叩いても安い（§1.1b）。
 */
export const PENDING_INTERVAL_MS = 3_000;

/** 待っていない間のポーリング間隔（他の端末から始まった解析に気づく程度でよい） */
export const IDLE_INTERVAL_MS = 30_000;

/**
 * 待っている間にルーターのローダーを作り直す間隔。
 *
 * ローダー再実行 = 一覧 / 詳細の API 呼び出しなので、進捗ポーリングより粗くする。
 * 10 秒は「チャンク submit で入った部分結果が育っていくのが分かる」（§2.5）粒度で、
 * かつ本番 quick の所要（≒ 20 秒）に対して完了を跨いでも 1 回以内で追いつく値。
 */
export const PENDING_INVALIDATE_INTERVAL_MS = 10_000;

/**
 * 標本が 1 つしか無い間に使う 1 局面あたりの所要時間（ms）。
 *
 * 本番 quick の `ENGINE_QUICK_MOVETIME`（150ms）の目安に由来する（prd/05 §1.1d の
 * 「quick 150ms で 120 局面 ≒ 20 秒」）。⚠ **server の設定値を web に配線しない**——
 * 2 標本目からは実測（Δanalyzed / Δt）で自己校正するので、この値は最初の数秒だけ効く。
 */
export const DEFAULT_MS_PER_POSITION = 150;

/**
 * 推定を進める経過の上限。ポーリング間隔の 3 倍。
 *
 * 漸近（`estimateAnalyzed`）で増分はこの時点で既に予測値の 99% を超えており、**見え方としては
 * ここまでに実質止まっている**。それでも上限を置くのは、経過が何分にもなったときに漸近の
 * 残差が浮動小数の下でつぶれ、**予測値そのもの（＝ `total` に達しうる値）に届く**のを防ぐため。
 *
 * 🔴 **「進捗が止まっていること」を隠さない**（§2.5「進捗が動くこと自体が生存確認」）のは
 * 漸近そのものが担う——標本が遅れるほど増分が減衰し、バーは目に見えて止まる。経過時間の表示
 * （`formatUpdatedAgo`）は伸び続けるので「バーは止まっているのに経過だけ伸びる」と読める。
 * ⚠ **これは stale の閾値ではない**（解析中の表示を消したり「死んでいる」と判定したりはしない）。
 */
export const ESTIMATE_HORIZON_MS = PENDING_INTERVAL_MS * 3;

/**
 * 漸近の時定数。次の標本が来るまで（`PENDING_INTERVAL_MS`）の半分。
 *
 * 標本が来る頃には予測値の 86%（1 - e^-2）まで進み、残りを次の標本が埋める。小さくすると
 * 前半で一気に進んで後半が止まって見え、大きくすると常に遅れて見える。
 */
const ESTIMATE_TAU_MS = PENDING_INTERVAL_MS / 2;

/** 実測ペースの平滑化係数（直近の観測をこの重みで効かせる指数平滑） */
const PACE_SMOOTHING = 0.5;

/** 0 除算と桁外れの外れ値を避けるための下限 */
const MIN_MS_PER_POSITION = 1;

/** 受け取った進捗（クライアント側の受信時刻付き）。推定の**基準点**になる */
export interface ProgressSample extends AnalysisProgress {
  /** この標本を受け取った時刻（`Date.now()`）。⚠ server 時計との差を持ち込まないため受信側で採る */
  receivedAt: number;
}

/** 推定に使う状態（直近の基準点と、実測から求めた 1 局面あたりの所要時間） */
export interface PaceState {
  latest: ProgressSample | null;
  /** 実測から求めた 1 局面あたりの所要時間（ms）。標本が 1 つしか無い間は null */
  msPerPosition: number | null;
}

export const initialPaceState: PaceState = { latest: null, msPerPosition: null };

/** 同じ解析の続きか（棋譜・世代・段階のいずれかが変われば別の解析＝ペースを引き継がない） */
export function isSameAnalysisRun(a: AnalysisProgress, b: AnalysisProgress): boolean {
  return (
    a.kifuId === b.kifuId && a.revision === b.revision && a.profile === b.profile
  );
}

/**
 * 新しい標本を取り込む。連続する標本の Δanalyzed / Δt から 1 局面あたりの所要時間を
 * 自己校正する（速度をハードコードしない）。
 */
export function nextPaceState(
  prev: PaceState,
  sample: ProgressSample,
): PaceState {
  const previous = prev.latest;
  if (!previous || !isSameAnalysisRun(previous, sample)) {
    return { latest: sample, msPerPosition: null };
  }
  const deltaAnalyzed = sample.analyzed - previous.analyzed;
  const deltaMs = sample.receivedAt - previous.receivedAt;
  if (deltaAnalyzed <= 0 || deltaMs <= 0) {
    // 進んでいない（または時計が戻った）標本ではペースを更新しない。
    // 基準点だけ進める——止まっているなら推定も止まってほしい
    return { latest: sample, msPerPosition: prev.msPerPosition };
  }
  const observed = Math.max(MIN_MS_PER_POSITION, deltaMs / deltaAnalyzed);
  const msPerPosition =
    prev.msPerPosition === null
      ? observed
      : prev.msPerPosition * (1 - PACE_SMOOTHING) + observed * PACE_SMOOTHING;
  return { latest: sample, msPerPosition };
}

/**
 * 基準点からの経過で解析済み局面数を補間する（進捗リング / バーを滑らかに進めるため）。
 *
 * 🔴 **線形に外挿しない**（決定・2026-09-07・後段。実測で踏んだ）。1 局面あたりの所要時間は
 * 同じ段階の中でも大きく振れる（定跡ヒットは即答・そうでない局面は数百 ms）ため、平滑値で
 * 線形に伸ばすと次の標本が来る前に何十局面ぶんも進み、**実データが 92/115 の時点でバーが満杯**
 * になって数秒張り付いた。`total` でクランプしても数値上は「追い越していない」だけで、
 * **表示としては追い越している**。
 *
 * 代わりに**次の標本で来るはずの値へ ease-out で漸近**させる:
 * `analyzed + (target - analyzed) * (1 - exp(-経過 / τ))`。
 * - 🔒 **予測値に到達しない**ので原理的に張り付かない。`target` を `total` で頭打ちにしてあるので、
 *   **実データが `total` に達していない限り推定も `total` に達しない**（クランプではなく漸近の性質）。
 * - 🔒 **標本が遅れるほど増分が減衰する**ので、止まっていることが見え方に出る。
 * - 🔒 基準点より戻らない（経過を 0 で下限）。
 *
 * 返すのは小数（バーの `value` にそのまま渡す）。**文字で出す N/M は実データのまま**にする
 * ——数字まで推定にすると「何局面終わったか」が嘘になる。
 */
export function estimateAnalyzed(state: PaceState, now: number): number {
  const base = state.latest;
  if (!base) return 0;
  const pace = Math.max(
    MIN_MS_PER_POSITION,
    state.msPerPosition ?? DEFAULT_MS_PER_POSITION,
  );
  // 次の標本までに進むはずの量。これを超えて進まない（超えた時点で実データを追い越す）
  const target = Math.min(base.analyzed + PENDING_INTERVAL_MS / pace, base.total);
  const elapsed = Math.min(
    Math.max(0, now - base.receivedAt),
    ESTIMATE_HORIZON_MS,
  );
  return (
    base.analyzed +
    (target - base.analyzed) * (1 - Math.exp(-elapsed / ESTIMATE_TAU_MS))
  );
}

/**
 * 進捗を 1 度も観測しないまま待ち続けたときに、ポーリングを長間隔へ戻すまでの時間。
 *
 * `pending`（未完了の棋譜が画面にある）はローダーのデータだけで決まるので、**worker が
 * 止まっていても真のまま**になる。開いたページを放置している間ずっと 3 秒間隔で叩き続ける
 * 必要はないので、5 分（本番 full の 1 局の所要 ≒ 2 分の倍以上——正常な解析の合間を
 * バックオフと取り違えない）観測が無ければ頻度を落とす。
 *
 * 🔴 **これは stale の閾値ではない**（§2.5 の「stale は閾値で消さない」は撤回しない）。
 * 「解析が死んでいる」という**判定はしないし、解析中の表示も消さない**。落とすのは
 * **見に行く頻度だけ**で、**進捗を 1 度でも観測すれば即座に短間隔へ戻る**。
 */
export const PENDING_BACKOFF_AFTER_MS = 5 * 60_000;

/**
 * バックオフ中のローダー作り直し間隔。
 *
 * 🔒 **止めずに落とすだけ**にする。完全に止めると「worker が後から動き出したのに画面が
 * 永久に切り替わらない」——今回直した不具合そのものへ戻る。**戻れること**が要点なので、
 * 進捗を観測できなくても 60 秒に 1 度はローダーを作り直し、完了していれば表示が入れ替わる。
 */
export const BACKOFF_INVALIDATE_INTERVAL_MS = 60_000;

/** 再取得の計画（ポーリング間隔と、ローダーを作り直す間隔。null は作り直さない） */
export interface PollingPlan {
  pollIntervalMs: number;
  invalidateIntervalMs: number | null;
}

/**
 * いまの状況から再取得の計画を決める（レベルトリガ。決定・2026-09-07）。
 *
 * - **待っている**（未完了の棋譜が画面にある）間は短間隔 + 10 秒ごとの作り直し。
 *   ただし進捗を 1 度も観測しないまま `PENDING_BACKOFF_AFTER_MS` を超えたら、
 *   ポーリングを長間隔へ戻す（**作り直しは止めず 60 秒へ落とす**——後から worker が
 *   動き出しても復帰できる）。
 * - **待っていない**間は長間隔・作り直しなし。
 *
 * `waitingSince` は「**最後に進捗を観測した時刻**、まだ観測していなければ待ち始めた時刻」。
 * 進捗を 1 度でも観測すれば呼び出し側がここを進めるので、**バックオフからは即座に戻る**。
 * 解析が動いている間は `pending` も真なので、観測できている限りバックオフには入らない。
 */
export function pollingPlan({
  pending,
  waitingSince,
  now,
}: {
  pending: boolean;
  waitingSince: number | null;
  now: number;
}): PollingPlan {
  if (!pending) {
    return { pollIntervalMs: IDLE_INTERVAL_MS, invalidateIntervalMs: null };
  }
  const backedOff =
    waitingSince !== null && now - waitingSince >= PENDING_BACKOFF_AFTER_MS;
  return backedOff
    ? {
        pollIntervalMs: IDLE_INTERVAL_MS,
        invalidateIntervalMs: BACKOFF_INVALIDATE_INTERVAL_MS,
      }
    : {
        pollIntervalMs: PENDING_INTERVAL_MS,
        invalidateIntervalMs: PENDING_INVALIDATE_INTERVAL_MS,
      };
}
