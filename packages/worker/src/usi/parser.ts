import type { UsiBestmove, UsiInfo, UsiScore } from "./types.js";

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
        const scoreValue = Number(tokens[++i]);
        if (scoreType === "cp" || scoreType === "mate") {
          info.score = { type: scoreType, value: scoreValue } as UsiScore;
        }
        break;
      }
      case "nodes":
        info.nodes = Number(tokens[++i]);
        break;
      case "nps":
        info.nps = Number(tokens[++i]);
        break;
      case "time":
        info.time = Number(tokens[++i]);
        break;
      case "multipv":
        info.multipv = Number(tokens[++i]);
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
