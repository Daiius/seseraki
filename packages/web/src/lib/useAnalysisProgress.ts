import { useEffect, useRef, useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import useSWR from 'swr';
import { client } from './honoClient';
import type { AnalysisProgress } from './analysisProgress';

// 解析中は短間隔、非解析中は長間隔でポーリングする。進捗エンドポイントはメモリ参照だけで
// DB を触らないので、解析中に数秒間隔で叩いても安い
const ACTIVE_INTERVAL_MS = 5_000;
const IDLE_INTERVAL_MS = 30_000;
// 経過時間の表示だけを進めるための刻み（分単位で読めればよい）
const TICK_INTERVAL_MS = 10_000;

const progressFetcher = async (): Promise<AnalysisProgress | null> => {
  const res = await client.api.analysis.progress.$get();
  if (!res.ok) throw new Error(`status ${res.status}`);
  return await res.json();
};

/**
 * 解析中の棋譜の進捗を購読する。worker は 1 件ずつ処理するので**解析中は高々 1 件**で、
 * 一覧も詳細もこれ 1 つを見て自分の id と一致したら表示する（一覧 SQL を再実行せずに済む）。
 *
 * `now` は経過時間の表示用。SWR は同じ値なら再レンダーしないため、worker がハングして
 * 進捗が止まると経過時間まで止まって見えてしまう。それでは「更新が止まっていること」を
 * 出したい意図と逆になるので、表示用の現在時刻は自前で刻む。
 */
export function useAnalysisProgress(): {
  progress: AnalysisProgress | null;
  now: number;
} {
  const { data } = useSWR<AnalysisProgress | null>(
    'analysis-progress',
    progressFetcher,
    {
      refreshInterval: (latest) =>
        latest ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS,
      revalidateOnFocus: false,
    },
  );
  const progress = data ?? null;

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!progress) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [progress]);

  // 進捗エントリが消えた / 別の棋譜へ移った = 直前の棋譜の解析が完了（または失敗）した。
  // 一覧のバッジも詳細の解析結果もローダー経由なので、ここで作り直さないと「解析中」が
  // 消えた後に古い「未」のまま残る。完了は数分〜数十分に 1 度なので素朴に invalidate してよい
  const router = useRouter();
  const previousKifuId = useRef<number | null>(null);
  useEffect(() => {
    const previous = previousKifuId.current;
    previousKifuId.current = progress?.kifuId ?? null;
    if (previous !== null && previous !== progress?.kifuId) {
      void router.invalidate();
    }
  }, [progress, router]);

  return { progress, now };
}
