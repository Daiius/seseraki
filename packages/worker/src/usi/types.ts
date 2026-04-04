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
}

export interface UsiBestmove {
  move: string;
  ponder?: string;
}

export interface UsiSearchResult {
  bestmove: UsiBestmove;
  infoLines: UsiInfo[];
  lastInfo: UsiInfo;
}
