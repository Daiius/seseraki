import { describe, expect, it } from "vitest";
import { parseKif } from "./parser.js";

/** ヘルパー: KIF テキストから USI 指し手列を取得 */
function parseToUsi(kifText: string): string[] {
  const result = parseKif(kifText);
  expect(result.errors).toEqual([]);
  return result.moves.map((m) => m.usi);
}

describe("parseKif", () => {
  it("基本的な指し手をパースする", () => {
    const kif = `
手合割：平手
   1 ７六歩(77)   ( 0:00/00:00:00)
   2 ３四歩(33)   ( 0:00/00:00:00)
   3 ２六歩(27)   ( 0:00/00:00:00)
`;
    expect(parseToUsi(kif)).toEqual(["7g7f", "3c3d", "2g2f"]);
  });

  it("駒打ちをパースする", () => {
    const kif = `
   1 ５五角打   ( 0:00/00:00:00)
   2 ３三桂打   ( 0:00/00:00:00)
`;
    expect(parseToUsi(kif)).toEqual(["B*5e", "N*3c"]);
  });

  it("「同」の指し手をパースする", () => {
    const kif = `
   1 ７六歩(77)   ( 0:00/00:00:00)
   2 同　飛(72)   ( 0:00/00:00:00)
`;
    expect(parseToUsi(kif)).toEqual(["7g7f", "7b7f"]);
  });

  it("明示的な「成」をパースする", () => {
    const kif = `
   1 ２二角成(88)   ( 0:00/00:00:00)
`;
    expect(parseToUsi(kif)).toEqual(["8h2b+"]);
  });

  it("「不成」はプロモーションしない", () => {
    const kif = `
   1 ２三桂不成(31)   ( 0:00/00:00:00)
`;
    expect(parseToUsi(kif)).toEqual(["3a2c"]);
  });

  describe("成駒名による暗黙の成り検出", () => {
    it("馬 = 角が成る手", () => {
      // 角を打って、次の手で馬として移動 → 成りが付くべき
      const kif = `
   1 ３七角打   ( 0:00/00:00:00)
   2 ３四歩(33)   ( 0:00/00:00:00)
   3 ４八馬(37)   ( 0:00/00:00:00)
`;
      const moves = parseToUsi(kif);
      expect(moves[2]).toBe("3g4h+");
    });

    it("既に成っている馬の移動には + が付かない", () => {
      const kif = `
   1 ３七角打   ( 0:00/00:00:00)
   2 ３四歩(33)   ( 0:00/00:00:00)
   3 ４八馬(37)   ( 0:00/00:00:00)
   4 ３三歩打   ( 0:00/00:00:00)
   5 ４九馬(48)   ( 0:00/00:00:00)
`;
      const moves = parseToUsi(kif);
      expect(moves[2]).toBe("3g4h+"); // 成る
      expect(moves[4]).toBe("4h4i");  // 既に馬、+ なし
    });

    it("龍 = 飛が成る手", () => {
      const kif = `
   1 ８二飛(28)   ( 0:00/00:00:00)
   2 ３四歩(33)   ( 0:00/00:00:00)
   3 ８一龍(82)   ( 0:00/00:00:00)
`;
      const moves = parseToUsi(kif);
      expect(moves[2]).toBe("8b8a+");
    });

    it("既に成っている龍の移動には + が付かない", () => {
      const kif = `
   1 ８二飛(28)   ( 0:00/00:00:00)
   2 ３四歩(33)   ( 0:00/00:00:00)
   3 ８一龍(82)   ( 0:00/00:00:00)
   4 ３三歩打   ( 0:00/00:00:00)
   5 ７一龍(81)   ( 0:00/00:00:00)
`;
      const moves = parseToUsi(kif);
      expect(moves[2]).toBe("8b8a+"); // 成る
      expect(moves[4]).toBe("8a7a");  // 既に龍
    });

    it("成香 = 香が成る手", () => {
      const kif = `
   1 ３三香打   ( 0:00/00:00:00)
   2 ３四歩(34)   ( 0:00/00:00:00)
   3 ３二成香(33)   ( 0:00/00:00:00)
`;
      const moves = parseToUsi(kif);
      expect(moves[2]).toBe("3c3b+");
    });

    it("成桂 = 桂が成る手", () => {
      const kif = `
   1 ２五桂打   ( 0:00/00:00:00)
   2 ３四歩(33)   ( 0:00/00:00:00)
   3 ３三成桂(25)   ( 0:00/00:00:00)
`;
      const moves = parseToUsi(kif);
      expect(moves[2]).toBe("2e3c+");
    });

    it("成銀 = 銀が成る手", () => {
      const kif = `
   1 ３三銀(24)   ( 0:00/00:00:00)
   2 ３四歩(34)   ( 0:00/00:00:00)
   3 ４二成銀(33)   ( 0:00/00:00:00)
`;
      const moves = parseToUsi(kif);
      expect(moves[2]).toBe("3c4b+");
    });

    it("と = 歩が成る手", () => {
      const kif = `
   1 ３四歩(35)   ( 0:00/00:00:00)
   2 ５五角打   ( 0:00/00:00:00)
   3 ３三と(34)   ( 0:00/00:00:00)
`;
      const moves = parseToUsi(kif);
      expect(moves[2]).toBe("3d3c+");
    });
  });

  describe("実戦の指し手列（Daiius vs ffullbacks より抜粋）", () => {
    it("成りチェーンを正しくパースする", () => {
      // 角打 → 馬への成り → 馬の移動（成り済み）
      const kif = `
  54 ３七角打   ( 0:00/00:00:00)
  55 ３三香打   ( 0:00/00:00:00)
  56 ４八馬(37)   ( 0:00/00:00:00)
  57 ３二成香(33)   ( 0:00/00:00:00)
  58 同　玉(41)   ( 0:00/00:00:00)
  59 ３三金打   ( 0:00/00:00:00)
  60 ４一玉(32)   ( 0:00/00:00:00)
  61 ４二金(33)   ( 0:00/00:00:00)
  62 同　金(52)   ( 0:00/00:00:00)
  63 ３三成桂(25)   ( 0:00/00:00:00)
  64 ４九馬(48)   ( 0:00/00:00:00)
`;
      const result = parseKif(kif);
      expect(result.errors).toEqual([]);
      const moves = result.moves.map((m) => m.usi);
      expect(moves).toEqual([
        "B*3g",   // 54: 角打
        "L*3c",   // 55: 香打
        "3g4h+",  // 56: 角 → 馬（成り）
        "3c3b+",  // 57: 香 → 成香（成り）
        "4a3b",   // 58: 玉
        "G*3c",   // 59: 金打
        "3b4a",   // 60: 玉
        "3c4b",   // 61: 金
        "5b4b",   // 62: 同金
        "2e3c+",  // 63: 桂 → 成桂（成り）
        "4h4i",   // 64: 馬の移動（既に成り済み、+ なし）
      ]);
    });
  });

  it("投了などの終局行はスキップする", () => {
    const kif = `
   1 ７六歩(77)   ( 0:00/00:00:00)
   2 投了
`;
    const result = parseKif(kif);
    expect(result.moves).toHaveLength(1);
  });

  it("ヘッダー・コメント行はスキップする", () => {
    const kif = `
手合割：平手
先手：Player1
後手：Player2
# コメント
   1 ７六歩(77)   ( 0:00/00:00:00)
*コメント行
   2 ３四歩(33)   ( 0:00/00:00:00)
`;
    expect(parseToUsi(kif)).toEqual(["7g7f", "3c3d"]);
  });
});
