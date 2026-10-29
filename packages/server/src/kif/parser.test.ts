import { describe, expect, it } from "vitest";
import { detectLegacyUtcTimezone, parseKif, parseRank } from "./parser.js";

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

  describe("実戦の指し手列（抜粋）", () => {
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

  describe("成駒の一文字略記（全 / 圭 / 杏）", () => {
    it("全 = 銀が成る手（暗黙の成り）", () => {
      const kif = `
   1 ３八銀打   ( 0:00/00:00:00)
   2 ３四歩(33)   ( 0:00/00:00:00)
   3 ４八全(38)   ( 0:00/00:00:00)
`;
      expect(parseToUsi(kif)[2]).toBe("3h4h+");
    });

    it("既に成っている全（成銀）の移動には + が付かない", () => {
      const kif = `
   1 ３八銀打   ( 0:00/00:00:00)
   2 ３四歩(33)   ( 0:00/00:00:00)
   3 ４八全(38)   ( 0:00/00:00:00)
   4 ３三歩打   ( 0:00/00:00:00)
   5 ４九全(48)   ( 0:00/00:00:00)
`;
      const moves = parseToUsi(kif);
      expect(moves[2]).toBe("3h4h+"); // 成る
      expect(moves[4]).toBe("4h4i"); // 既に成銀、+ なし
    });

    it("圭 = 成桂 / 杏 = 成香 の移動", () => {
      expect(
        parseToUsi(`
   1 ２五桂打   ( 0:00/00:00:00)
   2 ３四歩(33)   ( 0:00/00:00:00)
   3 ３三圭(25)   ( 0:00/00:00:00)
`)[2],
      ).toBe("2e3c+");
      expect(
        parseToUsi(`
   1 ３三香打   ( 0:00/00:00:00)
   2 ３四歩(34)   ( 0:00/00:00:00)
   3 ３二杏(33)   ( 0:00/00:00:00)
`)[2],
      ).toBe("3c3b+");
    });
  });

  describe("対局メタ（ヘッダ）抽出", () => {
    it("先手/後手/開始日時/手合割を抽出する", () => {
      const kif = `開始日時：2026/01/15 12:34:56
手合割：平手
先手：先手A
後手：daiius
   1 ２六歩(27)   ( 0:00/00:00:00)
   2 投了
`;
      const { header } = parseKif(kif);
      expect(header.sente).toBe("先手A");
      expect(header.gote).toBe("daiius");
      expect(header.handicap).toBe("平手");
      expect(header.playedAt?.toISOString()).toBe("2026-01-15T03:34:56.000Z");
    });

    it("名前の段位を分離する（段位でない称号は名前に残す）", () => {
      const { header } = parseKif(`先手：羽生善治 九段\n後手：藤井聡太 竜王\n`);
      expect(header.sente).toBe("羽生善治");
      expect(header.senteDan).toBe(9);
      expect(header.gote).toBe("藤井聡太 竜王");
      expect(header.goteDan).toBeNull();
    });

    it("将棋ウォーズ形式の段級行（別行）を取り込む", () => {
      const kif = `開始日時：2026/01/27 21:00:00
終了日時：2026/01/27 21:20:00
場所：将棋ウォーズ
持ち時間：10分切れ負け
手合割：平手
初期局面：通常
先手：先手A
先手段級：二段
後手：Daiius
後手段級：初段
手数----指手---------消費時間--
1 ７六歩(77)   ( 0:01/00:00:01)
2 投了
`;
      const { header } = parseKif(kif);
      expect(header.sente).toBe("先手A");
      expect(header.senteDan).toBe(2);
      expect(header.gote).toBe("Daiius");
      expect(header.goteDan).toBe(1); // 初段
    });

    // 将棋ウォーズの KIF は CRLF。行末に `\r` が残るとヘッダ抽出だけが全滅し
    // （`.` は `\r` にマッチせず `$` に届かない）、指し手は前方一致なので通るため
    // 「解析は完走するのに対局者名・日時だけ空」になる。改行は 3 種すべて受ける。
    it.each([
      ["CRLF", "\r\n"],
      ["CR", "\r"],
      ["LF", "\n"],
    ])("改行が %s でもヘッダと指し手を取り込む", (_name, eol) => {
      const kif = [
        "開始日時：2026/01/27 21:00:00",
        "場所：将棋ウォーズ",
        "手合割：平手",
        "先手：先手A",
        "先手段級：二段",
        "後手：Daiius",
        "後手段級：初段",
        "手数----指手---------消費時間--",
        "1 ７六歩(77)   ( 0:01/00:00:01)",
        "2 投了",
        "",
      ].join(eol);
      const { header, moves, errors } = parseKif(kif);
      expect(header.sente).toBe("先手A");
      expect(header.gote).toBe("Daiius");
      expect(header.senteDan).toBe(2);
      expect(header.goteDan).toBe(1);
      expect(header.handicap).toBe("平手");
      expect(header.playedAt).not.toBeNull();
      expect(header.result).toBe("SENTE_WIN_RESIGN");
      expect(moves.map((m) => m.usi)).toEqual(["7g7f"]);
      expect(errors).toEqual([]);
    });

    // BOM は先頭行のヘッダ 1 つだけを静かに落とす（`^開始日時` に一致しなくなる）。
    // アプリ間・OS 間の受け渡しで付くことがあるため、改行との組み合わせで確かめる。
    it.each([
      ["LF", "\n"],
      ["CRLF", "\r\n"],
    ])("先頭 BOM + %s でも先頭行のヘッダを落とさない", (_name, eol) => {
      const kif =
        "\uFEFF" +
        [
          "開始日時：2026/01/27 21:00:00",
          "先手：先手A",
          "後手：Daiius",
          "手数----指手---------消費時間--",
          "1 ７六歩(77)   ( 0:01/00:00:01)",
          "",
        ].join(eol);
      const { header } = parseKif(kif);
      // BOM が残ると先頭行だけ落ちて playedAt が null になる
      expect(header.playedAt).not.toBeNull();
      expect(header.sente).toBe("先手A");
      expect(header.gote).toBe("Daiius");
    });

    // 見えないゆえに目視で原因へ辿り着けない類のゆれ。すべて正規化で吸収する。
    describe("文字コード・空白のゆれを吸収する", () => {
      it("行頭のインデントと区切り前後の空白を許す", () => {
        // 指し手行（MOVE_RE）は行頭空白を受けるので、ヘッダだけ受けないと
        // 「指し手は通るのにメタが空」という同じ壊れ方になる
        const { header } = parseKif(
          ["  先手 ： 先手A", "\t後手：\tDaiius", "　手合割：平手"].join("\n"),
        );
        expect(header.sente).toBe("先手A");
        expect(header.gote).toBe("Daiius");
        expect(header.handicap).toBe("平手");
      });

      it("行中に紛れたゼロ幅文字でヘッダを落とさない", () => {
        // ZWSP が項目名を割ると、その行だけが静かに落ちる
        const { header } = parseKif(
          `先\u200B手：先手A\n後手：Da\u200Biius\n`,
        );
        expect(header.sente).toBe("先手A");
        expect(header.gote).toBe("Daiius");
      });

      it("NFD の濁点を NFC へ揃える（対局者名の同一性判定が外れないように）", () => {
        // macOS / iOS 間の受け渡しで「が」が「か」+ 濁点に分解されることがある。
        // 見た目は同じでも別の文字列なので、自分がどちらの側かの判定が静かに外れる
        // 「がとう」の NFD 表記（か + 結合濁点 U+3099）。見た目は NFC と区別が付かない
        const nfd = "\u304B\u3099\u3068\u3046";
        const { header } = parseKif(`先手：${nfd}\n後手：Daiius\n`);
        expect(header.sente).toBe("がとう");
        expect(nfd).not.toBe("がとう"); // 正規化しなければ別物であることの確認
      });

      it("全角英数の指し手は潰さない（NFKC を使っていないことの確認）", () => {
        // NFKC で正規化すると `２六歩` が `26歩` になり指し手が読めなくなる
        expect(parseToUsi(`   1 ２六歩(27)   ( 0:00/00:00:00)\n`)).toEqual([
          "2g2f",
        ]);
      });
    });

    it("級位は負数にする（値の大小がそのまま棋力の順序になる）", () => {
      const { header } = parseKif(
        `先手：Daiius\n先手段級：初段\n後手：後手B\n後手段級：1級\n`,
      );
      expect(header.senteDan).toBe(1);
      expect(header.goteDan).toBe(-1);
      // 格上格下の判定に符号付きの比較をそのまま使える
      expect(header.senteDan!).toBeGreaterThan(header.goteDan!);
    });

    it("段級行を名前行が上書きしない（段級行が先に来ても保持する）", () => {
      const { header } = parseKif(`先手段級：三段\n先手：Daiius\n`);
      expect(header.sente).toBe("Daiius");
      expect(header.senteDan).toBe(3);
    });

    describe("名前欄末尾と段級行が両方ある場合は段級行を優先する", () => {
      it("段級行が名前行より後にあっても優先する", () => {
        const { header } = parseKif(`先手：羽生善治 九段\n先手段級：三段\n`);
        expect(header.sente).toBe("羽生善治");
        expect(header.senteDan).toBe(3);
      });

      it("段級行が名前行より先にあっても優先する（出現順に依らない）", () => {
        const { header } = parseKif(`先手段級：三段\n先手：羽生善治 九段\n`);
        expect(header.sente).toBe("羽生善治");
        expect(header.senteDan).toBe(3);
      });

      it("後手も同様に出現順へ依存しない", () => {
        const { header } = parseKif(`後手段級：1級\n後手：後手B 五段\n`);
        expect(header.gote).toBe("後手B");
        expect(header.goteDan).toBe(-1);
      });

      it("段級行が解釈できないときは名前欄末尾へフォールバックする", () => {
        const { header } = parseKif(`先手段級：達人\n先手：羽生善治 九段\n`);
        expect(header.senteDan).toBe(9);
      });
    });

    it("開始日時を JST の Date にする", () => {
      const { header } = parseKif(`開始日時：2026/01/15 12:34:56\n`);
      expect(header.playedAt?.toISOString()).toBe("2026-01-15T03:34:56.000Z");
      expect(header.sourceTz).toBe("JST");
    });

    it("旧 UTC 署名（KIF形式コメント + 持ち時間）でも取り込みは JST として解釈する", () => {
      // App B は開始日時を JST で書くようになった。署名は変わらないので、署名で UTC と
      // 判定し続けると playedAt が 9h 未来へずれる。自動判定は廃止し、既定を JST にした。
      const kif = `# ----  KIF形式  ----
開始日時：2026/01/17 14:00:00
手合割：平手
先手：daiius
後手：後手B
持ち時間：10分+30秒
   1 ７六歩(77) ( 0:01/00:00:01)
   2 投了
`;
      const { header } = parseKif(kif);
      expect(header.sourceTz).toBe("JST");
      // 14:00 JST = 05:00Z
      expect(header.playedAt?.toISOString()).toBe("2026-01-17T05:00:00.000Z");
    });

    it("tzOverride を渡すと既定の JST より優先する（投入時のユーザー選択）", () => {
      // JST の KIF でも、UTC 指定なら UTC 解釈（+9h ずれる）
      const jstKif = `開始日時：2026/01/15 12:34:56\n`;
      const asUtc = parseKif(jstKif, "UTC").header;
      expect(asUtc.sourceTz).toBe("UTC");
      expect(asUtc.playedAt?.toISOString()).toBe("2026-01-15T12:34:56.000Z");
      // 旧 UTC 署名の KIF でも、JST 指定なら JST 解釈
      const bKif = `# ----  KIF形式  ----\n開始日時：2026/01/17 14:00:00\n持ち時間：10分+30秒\n`;
      const asJst = parseKif(bKif, "JST").header;
      expect(asJst.sourceTz).toBe("JST");
      expect(asJst.playedAt?.toISOString()).toBe("2026-01-17T05:00:00.000Z");
    });

    it("存在しない日付は正規化せず null にする", () => {
      // JS は 2026/02/30 を 3/2 に正規化するが、それを弾く
      expect(parseKif(`開始日時：2026/02/30 12:00:00\n`).header.playedAt).toBeNull();
      // 不正な時刻も同様
      expect(parseKif(`開始日時：2026/01/15 25:00:00\n`).header.playedAt).toBeNull();
    });
  });

  // 取り込み経路からは外したが、切替前に書き出された過去の KIF を読み直す backfill が使う。
  // 署名そのものが変わったわけではないので、指紋の絞り込みはそのまま検証しておく。
  describe("旧 UTC 署名の判定（過去行の再導出専用）", () => {
    it("3 条件が揃ったものだけ UTC とみなす", () => {
      const bKif = `# ----  KIF形式  ----
開始日時：2026/01/17 14:00:00
持ち時間：10分+30秒
`;
      expect(detectLegacyUtcTimezone(bKif)).toBe("UTC");
    });

    it("持ち時間のみ / KIF形式コメントのみでは UTC とみなさない", () => {
      expect(
        detectLegacyUtcTimezone(`開始日時：2026/01/17 14:00:00\n持ち時間：10分+30秒\n`),
      ).toBe("JST");
      expect(
        detectLegacyUtcTimezone(`# ----  KIF形式  ----\n開始日時：2026/01/17 14:00:00\n`),
      ).toBe("JST");
    });

    it("終了日時/場所を持つ JST 系アプリは署名が一致しても UTC とみなさない", () => {
      const withEnd = `# ----  KIF形式  ----
開始日時：2026/01/17 14:00:00
終了日時：2026/01/17 14:10:00
持ち時間：10分+30秒
`;
      expect(detectLegacyUtcTimezone(withEnd)).toBe("JST");
      const withPlace = `# ----  KIF形式  ----
開始日時：2026/01/17 14:00:00
場所：-
持ち時間：10分+30秒
`;
      expect(detectLegacyUtcTimezone(withPlace)).toBe("JST");
    });

    it("KIF形式コメントが先頭行でない場合は UTC とみなさない", () => {
      const notFirst = `開始日時：2026/01/17 14:00:00
# ----  KIF形式  ----
持ち時間：10分+30秒
`;
      expect(detectLegacyUtcTimezone(notFirst)).toBe("JST");
    });
  });

  describe("結果コードの導出（終局マーカー + 手番 parity）", () => {
    it("奇数手の詰みは後手勝ち（先手が詰み）", () => {
      expect(parseKif(`   1 ７六歩(77)\n  71 詰み\n`).header.result).toBe(
        "GOTE_WIN_CHECKMATE",
      );
    });
    it("偶数手の投了は先手勝ち", () => {
      expect(parseKif(`  80 投了\n`).header.result).toBe("SENTE_WIN_RESIGN");
    });
    it("千日手 / 持将棋 は引き分け、中断は結果なし", () => {
      expect(parseKif(`  50 千日手\n`).header.result).toBe("DRAW_REPETITION");
      expect(parseKif(`  90 持将棋\n`).header.result).toBe("DRAW_IMPASSE");
      expect(parseKif(`  30 中断\n`).header.result).toBeNull();
    });
    it("入玉宣言は引き分けでなく宣言側（手番側）の勝ち", () => {
      // 奇数手 = 先手が宣言 → 先手勝ち
      expect(parseKif(`  121 入玉宣言\n`).header.result).toBe(
        "SENTE_WIN_DECLARATION",
      );
      // 偶数手 = 後手が宣言 → 後手勝ち
      expect(parseKif(`  120 入玉宣言\n`).header.result).toBe(
        "GOTE_WIN_DECLARATION",
      );
    });
    it("終局マーカーは errors に入らない（詰み）", () => {
      const r = parseKif(`   1 ７六歩(77)\n  71 詰み\n`);
      expect(r.errors).toEqual([]);
      expect(r.moves).toHaveLength(1);
    });
  });

  describe("成銀略記「全」を含む 1 局（手で組んだ合法な手順）", () => {
    // 成銀の移動は「８一全(91)」のように一文字略記で書かれることがある。旧実装はこの略記を取りこぼし手が欠落 →
    // 手番 parity がズレて USI 列が破綻し illegal move でエンジンが落ちていた（実在の対局ではない）。
    const KIF = `開始日時：2026/01/15 12:34:56
手合割：平手
先手：先手A
後手：後手B
手数----指手---------消費時間--
   1 ７六歩(77) ( 0:01/00:00:01)
   2 ３四歩(33) ( 0:01/00:00:01)
   3 ２二角成(88) ( 0:01/00:00:02)
   4 同　銀(31) ( 0:01/00:00:02)
   5 ３一角打 ( 0:01/00:00:03)
   6 ８四歩(83) ( 0:01/00:00:03)
   7 ２二角成(31) ( 0:01/00:00:04)
   8 ８五歩(84) ( 0:01/00:00:04)
   9 ９二銀打 ( 0:01/00:00:05)
  10 ８六歩(85) ( 0:01/00:00:05)
  11 ９一銀成(92) ( 0:01/00:00:06)
  12 ８七歩成(86) ( 0:01/00:00:06)
  13 ８一全(91) ( 0:01/00:00:07)
  14 同　飛(82) ( 0:01/00:00:07)
  15 投了
`;

    it("全 14 手をエラーなく変換し、メタ・結果も取れる", () => {
      const r = parseKif(KIF);
      expect(r.errors).toEqual([]);
      expect(r.moves.map((m) => m.usi)).toEqual([
        "7g7f", "3c3d", "8h2b+", "3a2b", "B*3a", "8c8d", "3a2b+",
        "8d8e", "S*9b", "8e8f", "9b9a+", "8f8g+", "9a8a", "8b8a",
      ]);
      expect(r.moves[12].usi).toBe("9a8a"); // 手13 ８一全（成り済み成銀の移動、+ なし）
      expect(r.header.sente).toBe("先手A");
      expect(r.header.gote).toBe("後手B");
      expect(r.header.result).toBe("GOTE_WIN_RESIGN");
    });
  });
});

describe("parseRank", () => {
  it("段は正・級は負にする", () => {
    expect(parseRank("初段")).toBe(1);
    expect(parseRank("二段")).toBe(2);
    expect(parseRank("九段")).toBe(9);
    expect(parseRank("1級")).toBe(-1);
    expect(parseRank("10級")).toBe(-10);
  });

  it("全角数字・漢数字の級位も受ける", () => {
    expect(parseRank("１級")).toBe(-1);
    expect(parseRank("十級")).toBe(-10);
    expect(parseRank("三十級")).toBe(-30);
    expect(parseRank("二十五級")).toBe(-25);
  });

  it("段級でない表記は null にする", () => {
    expect(parseRank("竜王")).toBeNull();
    expect(parseRank("")).toBeNull();
    expect(parseRank("0級")).toBeNull();
    expect(parseRank("初級")).toBeNull(); // 「初」は初段のみ
  });

  it("妥当な範囲を超える段級は null にする（DB の smallint を超えさせない）", () => {
    // 境界: 九段 / 30級 までは受ける
    expect(parseRank("9段")).toBe(9);
    expect(parseRank("30級")).toBe(-30);
    // 範囲外
    expect(parseRank("10段")).toBeNull();
    expect(parseRank("31級")).toBeNull();
    // smallint（-32768〜32767）を超える桁、および Number() が Infinity になる桁数
    expect(parseRank("32768段")).toBeNull();
    expect(parseRank("99999級")).toBeNull();
    expect(parseRank(`${"9".repeat(400)}段`)).toBeNull();
  });
});
