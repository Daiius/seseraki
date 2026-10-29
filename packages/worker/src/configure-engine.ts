import type { Config } from "./config.js";
import type { UsiEngine } from "./usi/engine.js";

/** エンジンのオプションを適用し readyok まで待つ（起動時・再起動時で共用） */
export async function configureEngine(
  engine: Pick<UsiEngine, "setOption" | "ready">,
  config: Config,
): Promise<void> {
  engine.setOption("Threads", String(config.engineThreads));
  engine.setOption("USI_Hash", String(config.engineHash));
  // 読み筋(PV)を置換表から延長して出力させる。byoyomi で探索を打ち切ると、最後に出る
  // info 行が探索途中の暫定値になり、pv が 1〜2 手しか埋まっていないことがある
  // （新しい最善手が見つかった直後に時間切れになるケース）。そのままだと候補手一覧の
  // 読み筋が「2 手だけ」で表示され、先の展開が分からない。
  // 検討モードにすると、やねうら王が pv を置換表から辿って補完するので、打ち切られた
  // 局面でも読める長さの読み筋が出る（実測: 2 手 → 20 手超）。
  // 探索アルゴリズムには影響しない（pv を出力する瞬間に置換表を辿るだけ）。
  engine.setOption("ConsiderationMode", "true");
  if (config.engineEvalDir) {
    engine.setOption("EvalDir", config.engineEvalDir);
  }
  // 🔴 評価値の尺度（prd/05 §1.2・§1.3）。本番は 16 を明示する——EvalDir に eval_options.txt を置かない前提で、
  // isready で上書きされない。悪手判定・出題の閾値と保存済みの値の尺度を合わせるため、エンジンの既定値に頼らない
  if (config.engineFvScale !== undefined) {
    engine.setOption("FV_SCALE", String(config.engineFvScale));
  }
  if (config.engineBookDir) {
    engine.setOption("BookDir", config.engineBookDir);
    engine.setOption("BookFile", "user_book1.db");
    engine.setOption("IgnoreBookPly", "true");
    engine.setOption("FlippedBook", "true");
    engine.setOption("BookOnTheFly", "true");
    engine.setOption("BookMoves", "999");
    engine.setOption("BookEvalDiff", "0");
    engine.setOption("BookDepthLimit", "0");
  }
  await engine.ready();
}
