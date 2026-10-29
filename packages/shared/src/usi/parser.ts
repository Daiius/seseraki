import type { UsiBestmove, UsiInfo, UsiScore } from "./types";

/**
 * 手数の分からない詰み（`score mate +` / `score mate -`）を読む手数。符号は詰ます側（+ は手番側が詰ます）。
 * USI では手数が分からないときに符号だけを送ってよい。`Number("+")` は NaN になり、報告で拒否されるので、
 * **どの実際の手数よりも長い**値で置く（詰みの向きは保ち、手数の短さで選ぶ出題などには掛からない）
 */
export const MATE_UNKNOWN_PLIES = 9999;

/** `score mate <n>` の値。`+` / `-` だけなら符号付きの {@link MATE_UNKNOWN_PLIES} */
function parseMateValue(token: string | undefined): number {
  if (token === "+") return MATE_UNKNOWN_PLIES;
  if (token === "-") return -MATE_UNKNOWN_PLIES;
  return Number(token);
}

export function parseInfoLine(line: string): UsiInfo {
  const tokens = line.split(/\s+/);
  const info: UsiInfo = {};

  // skip leading "info" token
  let i = tokens[0] === "info" ? 1 : 0;

  while (i < tokens.length) {
    const key = tokens[i];
    switch (key) {
      case "depth":
        info.depth = Number(tokens[++i]);
        break;
      case "seldepth":
        info.seldepth = Number(tokens[++i]);
        break;
      case "score": {
        const scoreType = tokens[++i];
        const raw = tokens[++i];
        if (scoreType === "cp") {
          info.score = { type: "cp", value: Number(raw) } satisfies UsiScore;
        } else if (scoreType === "mate") {
          info.score = { type: "mate", value: parseMateValue(raw) } satisfies UsiScore;
        }
        break;
      }
      case "string": {
        // `info string <任意の文>`: 残りは文で、語を値として読まない（`info string depth 5 …` で depth を拾わない）
        return info;
      }
      case "nodes":
        info.nodes = Number(tokens[++i]);
        break;
      case "nps":
        info.nps = Number(tokens[++i]);
        break;
      case "hashfull":
        info.hashfull = Number(tokens[++i]);
        break;
      case "time":
        info.time = Number(tokens[++i]);
        break;
      case "multipv":
        info.multipv = Number(tokens[++i]);
        break;
      // lowerbound / upperbound は値を取らない単独フラグ（score の直後、pv より前に来る）
      case "lowerbound":
        info.bound = "lower";
        break;
      case "upperbound":
        info.bound = "upper";
        break;
      case "pv":
        // pv consumes all remaining tokens
        info.pv = tokens.slice(i + 1);
        return info;
      default:
        break;
    }
    i++;
  }

  return info;
}

export function parseBestmove(line: string): UsiBestmove {
  const tokens = line.split(/\s+/);
  // "bestmove <move> [ponder <move>]"
  const moveIndex = tokens.indexOf("bestmove");
  const move = tokens[moveIndex + 1] ?? "resign";

  const ponderIndex = tokens.indexOf("ponder");
  const ponder =
    ponderIndex !== -1 ? tokens[ponderIndex + 1] : undefined;

  return { move, ponder };
}
