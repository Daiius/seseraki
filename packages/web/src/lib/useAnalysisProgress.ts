import { useEffect, useRef, useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import useSWR from 'swr';
import { client } from './honoClient';
import {
  estimateAnalyzed,
  initialPaceState,
  isSameAnalysisRun,
  nextPaceState,
  IDLE_INTERVAL_MS,
  PENDING_INTERVAL_MS,
  PENDING_INVALIDATE_INTERVAL_MS,
  type AnalysisProgress,
  type PaceState,
} from './analysisProgress';

/**
 * 表示用の現在時刻を刻む間隔。推定でリング / バーを滑らかに進めるため、進捗があるときは
 * この粒度で再レンダーする（経過時間の表示は秒単位でしか変わらないのでこれで足りる）。
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
 * `now` は経過時間の表示と推定の補間用。SWR は同じ値なら再レンダーしないため、worker が
 * ハングして進捗が止まると経過時間まで止まって見えてしまう。それでは「更新が止まっていること」を
 * 出したい意図と逆になるので、表示用の現在時刻は自前で刻む。
 *
 * `estimated` は標本の間を埋めた解析済み局面数（小数）。**リング / バーの値にだけ使い、
 * 文字で出す N/M は実データのまま**にする。
 */
export function useAnalysisProgress(
  { pending = false }: { pending?: boolean } = {},
): {
  progress: AnalysisProgress | null;
  now: number;
  estimated: number;
} {
  const { data } = useSWR<AnalysisProgress | null>(
    'analysis-progress',
    progressFetcher,
    {
      // 進捗エントリが見えている間はもちろん、**見えていなくても待っている間**は短間隔で見る
      refreshInterval: (latest) =>
        latest || pending ? PENDING_INTERVAL_MS : IDLE_INTERVAL_MS,
      revalidateOnFocus: false,
    },
  );
  const progress = data ?? null;

  // 標本の受信時刻と実測ペース。SWR は内容が同じなら同じ参照を返すので、この effect は
  // **進捗が実際に動いたときだけ**走る（＝ `receivedAt` は「最後に進捗が動いた時刻」になる）
  const [pace, setPace] = useState<PaceState>(initialPaceState);
  useEffect(() => {
    if (!progress) {
      setPace(initialPaceState);
      return;
    }
    const receivedAt = Date.now();
    setPace((prev) => nextPaceState(prev, { ...progress, receivedAt }));
  }, [progress]);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!progress) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [progress]);

  // 基準点がいま表示している解析のものでないうち（別の棋譜 / 段階へ移った直後の 1 レンダー）は
  // 推定を使わず実データを出す。古い解析のペースで新しい解析のリングを進めない
  const estimated =
    progress && pace.latest && isSameAnalysisRun(pace.latest, progress)
      ? estimateAnalyzed(pace, now)
      : (progress?.analyzed ?? 0);

  const router = useRouter();

  // 進捗エントリが消えた / 別の棋譜へ移った / 段階が変わった = 直前の解析が一区切りした。
  // 一覧のバッジも詳細の解析結果もローダー経由なので、ここで作り直さないと「解析中」が
  // 消えた後に古い「未」のまま残る。⚠ `kifuId` だけを見ていると **quick 完了 → 同じ棋譜の
  // full 開始**（kifuId 据え置き・profile だけ変化）を取りこぼすので、段階も鍵に含める
  const previousKey = useRef<string | null>(null);
  useEffect(() => {
    const previous = previousKey.current;
    const current = progress ? `${progress.kifuId}:${progress.profile}` : null;
    previousKey.current = current;
    if (previous !== null && previous !== current) {
      void router.invalidate();
    }
  }, [progress, router]);

  // 🔴 エッジ検出の取りこぼしを塞ぐ本体。**未完了である限り**定期的にローダーを作り直す。
  // 完了の瞬間を観測できなくても次の周期で表示が入れ替わり、解析中はチャンク submit で
  // 入った部分結果がそのまま画面に育つ（prd/05 §2.5）
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => {
      void router.invalidate();
    }, PENDING_INVALIDATE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [pending, router]);

  return { progress, now, estimated };
}
