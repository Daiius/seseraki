/**
 * 棋譜・読みをまたいで使い回すエンジン 1 本（prd/14 §5.5・§5.10）。
 *
 * 全局面解析・出題の採点の読み・検討盤の局面評価が同じエンジンを使う。評価関数の選択・エンジンの大きさ
 * （スレッド数の上限・置換表）・負荷の設定が変わったら作り直し、失敗したら捨てて次に作り直す。
 * 段ごとのスレッド数の上限と、詰将棋の判定の固定のスレッド数は、作り直さずに `setThreads` で合わせる。
 *
 * 🔒 依存はすべて注入する（エンジンの作り方・負荷の設定・ログ）。Worker にも DOM にも触れない。
 */
import {
  stageMaxThreadsOf,
  type BrowserAnalysisSettings as ServerAnalysisSettings,
  type UsiAnalysisEngine,
} from 'shared';
import type { AnalysisLoad } from './settings';

/**
 * エンジンを作る・合わせるのに使う設定（スレッド数の上限・置換表）。全局面解析の設定（開始の口）・採点の読みの設定（server）・
 * 局面評価の設定（web の定数）のどれからでも渡せるように、要る欄だけにする
 */
export type EngineSettings = Pick<ServerAnalysisSettings, 'maxThreads' | 'stageMaxThreads' | 'hashMb'>;

/** 起動済み（`readyok` まで済んだ）のエンジン */
export interface AnalysisEngine {
  /** `getOption` は局面評価が MultiPV を元へ戻すのに使う（無ければ USI の既定の 1 へ戻す） */
  session: UsiAnalysisEngine & { getOption?(name: string): string | undefined };
  /** エンジンの名乗り（USI の `id name`） */
  name: string | null;
  /** いまのスレッド数（{@link AnalysisEngine.setThreads} で変わる） */
  readonly threads: number;
  hashMb: number;
  /**
   * 動いているエンジンのスレッド数を変える（`setoption Threads` → `isready`。詰将棋の判定の固定のスレッド数。prd/13 §5.5）。
   * null は負荷の設定で決まる数にする。その上限は `cap`（段ごとの上限。prd/14 §5.5）、省略時は作ったときの上限。
   * 同じ数なら何もしない。投げたらエンジンを作り直す（呼び出し側）
   */
  setThreads?(threads: number | null, cap?: number): Promise<void>;
  dispose(): void;
}

/** 来歴に記録するエンジンの値（選んだ評価関数の manifest のエントリから。prd/14 §5.9） */
export interface EngineInfo {
  /** エントリのエンジンのビルド識別（arch ごとに別） */
  engineBuild: string;
  /** `nn.bin` の sha256 */
  evalHash: string;
  fvScale: number;
}

/** いま選んでいる評価関数（端末の設定と manifest から。prd/14 §5.5） */
export interface EngineChoice {
  /** 評価関数の id（ログ用） */
  id: string;
  info: EngineInfo;
}

export interface RunnerLog {
  info(message: string): void;
  warn(message: string): void;
}

export interface EngineCacheDeps {
  /**
   * エンジンを読み込んで起動する。評価関数のダウンロードもここ（投げたら読み込みの失敗）。
   * ⚠ 棋譜の中断では止めない（詳細ページを離れただけで、数 MB のダウンロードを捨てない）。
   * 止めるのは常駐そのものを止めるときで、それは呼び出し側（`createEngine` の実装）が受け持つ
   */
  createEngine(
    settings: EngineSettings,
    load: AnalysisLoad,
    choice: EngineChoice,
    /** 固定のスレッド数（詰将棋の判定）。無ければ負荷の設定で決める。どちらでも `setThreads(null)` は負荷の設定の数に戻す */
    threads?: number,
  ): Promise<AnalysisEngine>;
  /**
   * 今の負荷の設定（端末の設定。prd/14 §5.10）。エンジンを求めるたびに読み、前と違えばエンジンを作り直す
   * ——スレッド数の変更は、次の解析（次の段・次の棋譜）の開始から効く
   */
  currentLoad(): AnalysisLoad;
  log: RunnerLog;
}

/** 止めた（`dispose`）後に頼まれた */
export const STOPPED_DETAIL = '解析は停止済みです';

/** 選んだ評価関数に同意していないときの文（ログ・採点の読みの失敗） */
export const NEEDS_CONSENT_DETAIL = '選んだ評価関数のダウンロードに同意していません';

/**
 * 作り直すかを決めるキー。評価関数の選択（端末の設定）・エンジンのスレッド数の上限（段で共通の `maxThreads`）・
 * 置換表の指定（server の定数）・負荷の設定（端末の設定）のどれかが変わったら、別のキーになる。
 *
 * 🔒 **段ごとの上限（`stageMaxThreads`）と固定のスレッド数はキーに入れない**——段・判定が変わるたびに作り直すと、
 * そのたびに評価関数の読み込みからになる（`setThreads` で合わせる）。
 * ⚠ 負荷の設定の変更は動いているエンジンに setoption で変えず、作り直す（prd/14 §5.10 の決定のまま）
 */
export function engineKey(
  choice: EngineChoice,
  settings: Pick<EngineSettings, 'maxThreads' | 'hashMb'>,
  load: AnalysisLoad,
): string {
  return `${choice.id}:${choice.info.engineBuild}:${choice.info.evalHash}:${settings.maxThreads}:${settings.hashMb}:${load}`;
}

export interface AcquireOptions {
  /**
   * 🔒 **今あるエンジンの大きさ（`maxThreads`・`hashMb`）をそのまま使う**——キーの比較から `settings` の大きさを外す。
   * 評価関数の選択と負荷の設定が同じなら、大きさが違っても作り直さない。エンジンが無いときだけ `settings` の大きさで作る。
   * 検討盤の局面評価（web の定数で頼む。server を経由しない）が使う: server の全局面解析の大きさと web の定数を
   * 手で揃えておく必要をなくす（ずれると、評価のたびに評価関数の読み込みから作り直すことになる）
   */
  followCurrentSizing?: boolean;
}

export interface EngineCache {
  /**
   * 求める設定のエンジンを返す（無い・キーが違えば作り直す）。段の上限・固定のスレッド数に合わせてから返す。
   * 止めた後は投げる（{@link STOPPED_DETAIL}）。投げたら呼び出し側が {@link EngineCache.discard} する
   * @param threads 固定のスレッド数（詰将棋の判定。prd/13 §5.5）。無ければ負荷の設定で決まる数（全局面解析・次の一手）
   */
  acquire(
    settings: EngineSettings,
    choice: EngineChoice,
    threads?: number,
    options?: AcquireOptions,
  ): Promise<AnalysisEngine>;
  /** 今のエンジンを捨てる（次の `acquire` で作り直す）。エンジンが失敗したとき */
  discard(): void;
  /** 止める。以後エンジンを作らない */
  dispose(): void;
  isDisposed(): boolean;
}

export function createEngineCache(deps: EngineCacheDeps): EngineCache {
  let engine: AnalysisEngine | null = null;
  let currentKey = '';
  /** 今のエンジンを作ったときの設定（{@link AcquireOptions.followCurrentSizing}） */
  let createdSettings: EngineSettings | null = null;
  let disposed = false;

  const discard = () => {
    engine?.dispose();
    engine = null;
  };

  const acquire = async (
    settings: EngineSettings,
    choice: EngineChoice,
    threads?: number,
    options: AcquireOptions = {},
  ): Promise<AnalysisEngine> => {
    // 止めた後はエンジンを作らない（作ってすぐ捨てる読み込み・Worker の起動をしない）
    if (disposed) throw new Error(STOPPED_DETAIL);
    const load = deps.currentLoad();
    // 🔒 キーに使う大きさと、作り直すときに渡す大きさを同じものにする（レビュー OCL-20FAB760）。
    // 大きさを今のエンジンに合わせるときは、評価関数・負荷の変更で作り直すときもその大きさで作る
    // ——キーと実物が食い違うと、次の読みで要らない作り直しをしたり、違う大きさのエンジンを使い回したりする
    const effective: EngineSettings =
      options.followCurrentSizing && engine && createdSettings
        ? { ...settings, maxThreads: createdSettings.maxThreads, hashMb: createdSettings.hashMb }
        : settings;
    const key = engineKey(choice, effective, load);
    if (!engine || currentKey !== key) {
      if (engine) deps.log.info(`recreating the engine (${currentKey} -> ${key})`);
      discard();
      // 作るときは求めるスレッド数で作る（起動の経路と同じ。setoption での切り替えに頼らない）
      const created = await deps.createEngine(effective, load, choice, threads);
      if (disposed) {
        // 読み込んでいる間に止められた。使わずに捨てる
        created.dispose();
        throw new Error(STOPPED_DETAIL);
      }
      engine = created;
      currentKey = key;
      createdSettings = effective;
    }
    // 🔒 **詰将棋の判定の固定のスレッド数は、作り直さずに切り替える**（`setoption Threads` → `isready`）。
    // 上流は `setoption Threads` でその場でスレッドを作り直し（`resize_threads`）、`isready` でもう一度揃える。
    // 評価関数は読み直さない（作り直すと評価関数の読み込みからになり、1 手の判定が秒単位で遅れる）。
    // 全局面解析に戻るときは null で負荷の設定の数に戻す。切り替えに失敗したら投げる——呼び出し側がエンジンを作り直す
    // （作り直しは上の、求める数で作る経路を通る）
    // 🔒 **段ごとのスレッド数の上限（full は 4。prd/14 §5.5）も同じ経路で合わせる**（{@link engineKey}）
    await engine.setThreads?.(threads ?? null, stageMaxThreadsOf(settings));
    return engine;
  };

  return {
    acquire,
    discard,
    dispose: () => {
      disposed = true;
      discard();
    },
    isDisposed: () => disposed,
  };
}
