/**
 * ブラウザのエンジン 1 本で、全局面解析と 1 局面の読みを受け持つ（prd/14 §5.2・§5.8・§5.10）。
 *
 * 部品を束ねるだけの薄い工場。判断はそれぞれの部品にある:
 * - {@link createEngineCache}（`engineCache.ts`）: 棋譜・読みをまたいで使い回すエンジン 1 本（作り直し・スレッド数の合わせ方）
 * - {@link createKifuAnalysis}（`kifuAnalysis.ts`）: 1 つの棋譜の解析（開始 → 解析 → 報告。失敗の扱い）
 * - {@link createEngineReads}（`engineReads.ts`）: 出題の採点の名指し評価・検討盤の局面評価
 *
 * 🔒 **依存はすべて注入する**（API・エンジン・時計・待ち・画面の可視）。DOM にも fetch にも触れないので、
 * 偽のエンジンと偽の API で unit テストできる（`runner.test.ts`）。
 */
import { createEngineCache, type EngineCacheDeps } from './engineCache';
import { createEngineReads, type EngineReads } from './engineReads';
import {
  createKifuAnalysis,
  type AnalyzeHooks,
  type KifuAnalysisDeps,
  type KifuOutcome,
} from './kifuAnalysis';

export type RunnerDeps = EngineCacheDeps & KifuAnalysisDeps;

export interface BrowserEngineRunner extends EngineReads {
  /**
   * 1 つの棋譜を解析する（quick → full を続けて）。`signal` で中断すると、局面の境目で未送信のチャンクを送ってから戻る
   */
  analyze(
    kifuNo: number,
    signal: AbortSignal,
    hooks?: AnalyzeHooks,
  ): Promise<KifuOutcome>;
  /** エンジンを止める。以後エンジンを作らない */
  dispose(): void;
}

export function createBrowserEngineRunner(deps: RunnerDeps): BrowserEngineRunner {
  const engines = createEngineCache(deps);
  const reads = createEngineReads(deps, engines);
  return {
    analyze: createKifuAnalysis(deps, engines),
    evaluateNamed: reads.evaluateNamed,
    evaluatePosition: reads.evaluatePosition,
    dispose: () => engines.dispose(),
  };
}
