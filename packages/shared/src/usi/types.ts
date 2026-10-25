export type UsiScore =
  | { type: "cp"; value: number }
  | { type: "mate"; value: number };

export interface UsiInfo {
  depth?: number;
  seldepth?: number;
  score?: UsiScore;
  pv?: string[];
  nodes?: number;
  nps?: number;
  time?: number;
  multipv?: number;
  /**
   * 置換表の使用率（パーミル・0〜1000）。
   *
   * 置換表が溢れると探索効率が落ちる。`USI_Hash` が今のワークロード（movetime /
   * MultiPV / 1 局ぶんの蓄積）に足りているかは、サイズではなくこの値で判断する。
   */
  hashfull?: number;
  /**
   * aspiration window の外に出た（fail low / fail high）ことを示すフラグ。
   * この行の score は真の値ではなく上限/下限でしかなく、pv も再探索前の
   * 途中経過なので 1〜2 手しか埋まっていないことがある。
   */
  bound?: "lower" | "upper";
}

export interface UsiBestmove {
  move: string;
  ponder?: string;
}

export interface UsiSearchResult {
  bestmove: UsiBestmove;
  infoLines: UsiInfo[];
  lastInfo: UsiInfo;
  /**
   * 探索を打ち切った `info`（{@link UsiAnalyzeOptions.stopWhen} が true を返した行）。打ち切っていなければ無い。
   * `stop` の後にエンジンが出す行は `infoLines` に残るが、判定にはこの行を使う（打ち切った理由の値）
   */
  stoppedBy?: UsiInfo;
}

/** `analyze` の追加の指定 */
export interface UsiAnalyzeOptions {
  /**
   * `info` 行ごとに呼ぶ。最初に true を返した時点で `stop` を 1 度だけ送り、その行を {@link UsiSearchResult.stoppedBy} に残す
   * （その後の `bestmove` までは今までどおり待つ）
   */
  stopWhen?(info: UsiInfo): boolean;
}
