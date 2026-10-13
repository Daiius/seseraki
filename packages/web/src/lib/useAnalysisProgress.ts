import { useEffect, useRef, useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import useSWR from 'swr';
import { client } from './honoClient';
import type { AnalysisAssignee } from './auth';
import { useBrowserAnalysisState } from './browserAnalysis/store';
import {
  estimateAnalyzed,
  initialPaceState,
  isSameAnalysisRun,
  nextPaceState,
  pollingPlan,
  PENDING_BACKOFF_AFTER_MS,
  type AnalysisProgress,
  type PaceState,
} from './analysisProgress';

/**
 * 表示用の現在時刻を刻む間隔。推定でリングを滑らかに進めるため、進捗があるときは
 * この粒度で再レンダーする。
 * 刻むのは進捗エントリがあるときだけなので、解析していない間の再レンダーは増えない。
 */
const TICK_INTERVAL_MS = 500;

const progressFetcher = async (): Promise<AnalysisProgress | null> => {
  const res = await client.api.analysis.progress.$get();
  if (!res.ok) throw new Error(`status ${res.status}`);
  return await res.json();
};

/**
 * 解析中の棋譜の進捗を購読する。worker は 1 件ずつ処理するので**解析中は高々 1 件**で、
 * 一覧も詳細もこれ 1 つを見て自分の id と一致したら表示する（一覧 SQL を再実行せずに済む）。
 *
 * 🔴 **再取得はレベルトリガ**（決定・2026-09-07。prd/05 §2.5）。`pending`（= 画面に解析の
 * 完了を待っている棋譜があるか。**ローダーのデータから導ける条件**）が真である限り、
 * 短間隔ポーリング + 定期 invalidate を回す。揮発的な進捗エントリの**変化**を粗い
 * サンプリングで捉える設計だと、解析全体（本番 quick ≒ 20 秒）が 2 回のポーリングの合間に
 * 収まって 1 度も観測されず、画面が解析前のまま固まる（実測・2026-09-07）。
 * **標本を落としても次の周期で回復する**のがレベルトリガの要点。
 *
 * 進捗を長く観測できないまま待ち続けたら、**ポーリングだけ**長間隔へ戻す（`pollingPlan`）。
 * ⚠ **これは stale の判定ではない**——解析中の表示は消さず、ローダーの作り直しも止めない
 * （間隔を落とすだけ）。進捗を 1 度でも観測すれば即座に短間隔へ戻る。
 *
 * 推定の補間に使う現在時刻は自前で刻む（SWR は同じ値なら再レンダーしないため、標本の合間に
 * 円環を進めるには別に再レンダーの契機が要る）。
 *
 * `estimated` は標本の間を埋めた解析済み局面数（小数）。**リング / バーの値にだけ使い、
 * 文字で出す N/M は実データのまま**にする。
 */
export function useAnalysisProgress({
  pending = false,
  assignee = 'worker',
}: {
  pending?: boolean;
  /**
   * 解析する側（prd/14 §5.7）。`browser` では **server に進捗を聞かず**（進捗を server に持たせない。§5.8）、
   * このタブの解析の進捗（`browserAnalysis/store`）を返す。定期的なローダーの作り直しはどちらでも回す
   * ——別のタブ・別の端末が解析していても、入った局面が画面に育つ
   */
  assignee?: AnalysisAssignee;
} = {}): {
  progress: AnalysisProgress | null;
  estimated: number;
} {
  const remote = assignee === 'worker';
  const local = useBrowserAnalysisState().progress;
  // 「最後に進捗を観測した時刻、まだ観測していなければ待ち始めた時刻」。
  // **1 度でも観測すればここが進み、バックオフのタイマーもリセットされる**
  const [waitingSince, setWaitingSince] = useState<number | null>(null);
  // バックオフの境界（進捗を観測しないまま 5 分）は時計が進むだけで訪れ、他に再レンダーの
  // 理由が無い。境界にタイマーを置いて、そこで計画を評価し直す
  const [planNow, setPlanNow] = useState(() => Date.now());

  // ⚠ `refreshInterval` には**数値**を渡す。SWR のポーリング effect はこの値を依存に持つので、
  // 関数を渡すと**レンダーのたびに識別子が変わってタイマーが張り直される**（解析中は 500ms
  // ごとに再レンダーするため、3 秒のポーリングが永遠に発火しなくなりうる）
  const plan = pollingPlan({ pending, waitingSince, now: planNow });

  const { data } = useSWR<AnalysisProgress | null>(
    // ブラウザで解析するユーザーでは叩かない（key が null の間、SWR は取得しない）
    remote ? 'analysis-progress' : null,
    progressFetcher,
    {
      refreshInterval: plan.pollIntervalMs,
      revalidateOnFocus: false,
    },
  );
  // ブラウザの解析は 1 段だけ（quick として保存する）。それが最終段なので、表示は薄くしない
  // ——`profile` は円環の濃さにしか使わないので、濃いほう（`full`）として渡す
  const localProgress: AnalysisProgress | null = local
    ? {
        kifuNo: local.kifuNo,
        revision: local.revision,
        profile: 'full',
        analyzed: local.analyzed,
        total: local.total,
        updatedAt: '',
      }
    : null;
  const progress = remote ? (data ?? null) : localProgress;
  // 進捗の中身を表す値（同じ間は同じ文字列）。ローカルの進捗は毎レンダーで作り直すので、
  // 「進捗を観測した」の effect はオブジェクトではなくこれを見る
  const progressKey = progress
    ? `${progress.kifuNo}:${progress.revision}:${progress.profile}:${progress.analyzed}`
    : null;

  useEffect(() => {
    if (progressKey !== null) {
      // 観測できた＝ worker は動いている。バックオフの起点を引き直す
      setWaitingSince(Date.now());
      return;
    }
    if (!pending) {
      setWaitingSince(null);
      return;
    }
    // 待ち始め。既に待っているなら起点は動かさない（表示中の棋譜が変わって pending が
    // 偽→真になったときは、上の `!pending` で null に戻っているので起点が引き直される）
    setWaitingSince((previous) => previous ?? Date.now());
  }, [progressKey, pending]);

  useEffect(() => {
    if (!pending || waitingSince === null) return;
    const remaining = PENDING_BACKOFF_AFTER_MS - (Date.now() - waitingSince);
    if (remaining <= 0) return;
    const timer = setTimeout(() => setPlanNow(Date.now()), remaining);
    return () => clearTimeout(timer);
  }, [pending, waitingSince]);

  // 標本の受信時刻と実測ペース。SWR は内容が同じなら同じ参照を返すので、この effect は
  // **進捗が実際に動いたときだけ**走る（＝ `receivedAt` は「最後に進捗が動いた時刻」になる）
  const [pace, setPace] = useState<PaceState>(initialPaceState);
  // ⚠ 推定で埋めるのは server の進捗（数秒おきの標本）だけ。ローカルの進捗は局面ごとに届くので、そのまま出す
  const sampled = remote ? (data ?? null) : null;
  useEffect(() => {
    if (!sampled) {
      setPace(initialPaceState);
      return;
    }
    const receivedAt = Date.now();
    setPace((prev) => nextPaceState(prev, { ...sampled, receivedAt }));
  }, [sampled]);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!sampled) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [sampled]);

  // 基準点がいま表示している解析のものでないうち（別の棋譜 / 段階へ移った直後の 1 レンダー）は
  // 推定を使わず実データを出す。古い解析のペースで新しい解析のリングを進めない
  const estimated =
    sampled && pace.latest && isSameAnalysisRun(pace.latest, sampled)
      ? estimateAnalyzed(pace, now)
      : (progress?.analyzed ?? 0);

  const router = useRouter();

  // 進捗エントリが消えた / 別の棋譜へ移った / 段階が変わった = 直前の解析が一区切りした。
  // 一覧のバッジも詳細の解析結果もローダー経由なので、ここで作り直さないと「解析中」が
  // 消えた後に古い「未」のまま残る。⚠ `kifuNo` だけを見ていると **quick 完了 → 同じ棋譜の
  // full 開始**（kifuNo 据え置き・profile だけ変化）を取りこぼすので、段階も鍵に含める
  const previousKey = useRef<string | null>(null);
  const runKey = progress ? `${progress.kifuNo}:${progress.profile}` : null;
  useEffect(() => {
    const previous = previousKey.current;
    previousKey.current = runKey;
    if (previous !== null && previous !== runKey) {
      void router.invalidate();
    }
  }, [runKey, router]);

  // 🔴 エッジ検出の取りこぼしを塞ぐ本体。**未完了である限り**定期的にローダーを作り直す。
  // 完了の瞬間を観測できなくても次の周期で表示が入れ替わり、解析中はチャンク submit で
  // 入った部分結果がそのまま画面に育つ（prd/05 §2.5）。
  // ⚠ バックオフ中も**止めずに間隔を落とすだけ**にする（`pollingPlan`）——止めると
  // 「worker が後から動き出したのに画面が永久に切り替わらない」が復活する
  const invalidateIntervalMs = plan.invalidateIntervalMs;
  useEffect(() => {
    if (invalidateIntervalMs === null) return;
    const timer = setInterval(() => {
      void router.invalidate();
    }, invalidateIntervalMs);
    return () => clearInterval(timer);
  }, [invalidateIntervalMs, router]);

  return { progress, estimated };
}
