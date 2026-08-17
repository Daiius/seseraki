import {
  bigint,
  boolean,
  customType,
  foreignKey,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  serial,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { defineRelations } from 'drizzle-orm';

export const kifus = mysqlTable(
  'kifus',
  {
    id: serial().primaryKey(),
    title: varchar({ length: 255 }).notNull(),
    kifText: text().notNull(),
    usiMoves: json().$type<string[]>(),
    sente: varchar({ length: 100 }),
    gote: varchar({ length: 100 }),
    senteDan: smallint(),
    goteDan: smallint(),
    result: varchar({ length: 50 }),
    swarsGameKey: varchar({ length: 255 }).unique(),
    playedAt: timestamp(),
    // playedAt の解釈に用いたタイムゾーン。手動貼り付け KIF は開始日時に
    // タイムゾーン欄が無いため、投入時に決めた TZ（"JST" 既定 / "UTC" は投入時指定）を残す。
    // swars 経路は gameKey 由来で常に "JST"。
    sourceTz: varchar({ length: 8 }),
    analysisCompletedAt: timestamp(),
    analysisError: text(),
    // 解析世代。reanalyze で +1 し、worker の submit/error 報告は取得時と同一世代のみ受理
    // （実行中の旧解析がリセット後の状態を上書きするのを防ぐ）
    analysisRevision: int().notNull().default(0),
    memo: text(),
    // 棋譜の出所（prd/10 §2.1）。動画解析（'video'）は自分の対局ではないため、
    // 🔒 一覧・分析・統計のクエリは `source <> 'video'` を**既定で強制する**
    // （引数で外せる条件にしない。prd/10 §2.2）。既定値は安全側の 'manual'。
    source: mysqlEnum(['manual', 'swars', 'video']).notNull().default('manual'),
    createdAt: timestamp().notNull().defaultNow(),
    updatedAt: timestamp().notNull().defaultNow().onUpdateNow(),
  },
  (table) => [
    index('kifus_analysis_completed_at_idx').on(table.analysisCompletedAt),
    // 動画解析の一覧は source で絞ってから並べる（prd/10 §6.1）
    index('kifus_source_idx').on(table.source),
  ],
);

/**
 * 動画解析の由来メタ（`kifus` と 1:1。prd/10 §3.1）。
 *
 * **`kifus` に列を足さず外出しする**のは、自分の対局行で常に NULL になる列を
 * 中心テーブルに持ち込まないため。
 *
 * ⭐ **`raw` に走査の生出力を丸ごと持つ**（1 局 8〜16KB）。後から仕様を変えても
 * 再走査せずに派生値を作り直せる。手ごとのメタ（time / side / inferredKind）はここに入る。
 * 🔒 索引が要ると分かった値だけ、後から `raw` の外に列として昇格させる。
 */
export const videoKifuSources = mysqlTable(
  'video_kifu_sources',
  {
    // ⚠ FK は下の table extras で `foreignKey()` として書く。列側の `.references()` は
    // **単一列 PK のテーブルでは生成 SQL から `ON DELETE CASCADE` が落ちる**
    // （複合 PK の kifuTactics では落ちない）。CASCADE が無いと棋譜を消せなくなる
    kifuId: bigint({ mode: 'number', unsigned: true }).notNull(),
    /** 動画の識別子 */
    videoId: varchar({ length: 32 }).notNull(),
    /** その動画の何局目か（1 始まり） */
    gameIndex: int().notNull(),
    /** 断片の開始秒 / 終了秒 */
    startedAtSec: int().notNull(),
    endedAtSec: int().notNull(),
    /** 画面の下が先手か（録画者の側を示す。主体側の導出に使う。prd/10 §3.3） */
    bottomIsSente: boolean().notNull(),
    /** 走査時のコミット。上書きの経緯を辿るために残す */
    extractorRev: varchar({ length: 40 }).notNull(),
    /** 走査の生出力（range / replay / moves[{time,usi,side,inferredKind}]） */
    raw: json().notNull(),
    createdAt: timestamp().notNull().defaultNow(),
    updatedAt: timestamp().notNull().defaultNow().onUpdateNow(),
  },
  (table) => [
    primaryKey({ columns: [table.kifuId] }),
    foreignKey({
      columns: [table.kifuId],
      foreignColumns: [kifus.id],
    }).onDelete('cascade'),
    // 「同じ動画の同じ局」は 1 つの実体。再取り込みはこのキーで上書きする（prd/10 §4.3）
    uniqueIndex('video_kifu_sources_video_id_game_index_uq').on(
      table.videoId,
      table.gameIndex,
    ),
  ],
);

// 1手ごとの解析結果
export const moveAnalyses = mysqlTable(
  'move_analyses',
  {
    id: serial().primaryKey(),
    kifuId: bigint({ mode: 'number', unsigned: true })
      .notNull()
      .references(() => kifus.id, { onDelete: 'cascade' }),
    moveNumber: int().notNull(),
    createdAt: timestamp().notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('move_analyses_kifu_id_move_number_uq').on(
      table.kifuId,
      table.moveNumber,
    ),
  ],
);

// MultiPV の各候補手
/**
 * 戦型ラベル（prd/03 §2.1）。`usiMoves` から導く**派生値**で、正は指し手列。
 * この表は絞り込みと集計を SQL で行うための索引にすぎない。
 */
export const kifuTactics = mysqlTable(
  'kifu_tactics',
  {
    kifuId: bigint({ mode: 'number', unsigned: true })
      .notNull()
      .references(() => kifus.id, { onDelete: 'cascade' }),
    /** ラベルの**帰属先**。「立った手番」ではない（prd/03 §2.1.1） */
    side: mysqlEnum(['sente', 'gote', 'both']).notNull(),
    /** 一次 / 二次ラベル名。**表示名そのもの**（enum やコード値にしない） */
    label: varchar({ length: 32 }).notNull(),
    /** 成立手数。表示の抑制に使う。**絞り込み条件には使わない**（prd/03 §2.1.2） */
    turn: int().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.kifuId, table.side, table.label] }),
    index('kifu_tactics_label_idx').on(table.label),
  ],
);

/**
 * 固定長バイト列（`binary(N)`）を **Buffer のまま**扱う。
 *
 * ⚠ drizzle の `binary()` は値を string として扱うので、そのままでは
 * `Buffer` を渡せず、読み出しも文字列になる（charset 変換で壊れうる）。
 * 局面の盤・持ち駒はバイト列そのものに意味があるため、型を通す。
 */
const bytes = (length: number) =>
  customType<{ data: Buffer; driverData: Buffer }>({
    dataType: () => `binary(${length})`,
  })();

/**
 * 局面索引（`kifus` に紐付く派生値。prd/10 §3.2）。
 *
 * **全棋譜（自分の対局を含む）の全局面**を展開する。正は `kifus.usiMoves` で、
 * この表は**手順前後を吸収して盤の配置で探す**ための索引にすぎない（`kifuTactics` と同じ立場）。
 *
 * 🔒 **`usiMoves` が変われば必ず作り直す**（同一トランザクション）。全件の作り直しは
 * `rebuild-positions.ts`。
 */
export const kifuPositions = mysqlTable(
  'kifu_positions',
  {
    kifuId: bigint({ mode: 'number', unsigned: true }).notNull(),
    /** 0 = 初期局面。N は N 手適用後の局面 */
    moveNumber: int().notNull(),
    /**
     * この局面に**至った直前の手**（USI）。`moveNumber = 0` では null。
     * ⭐ 枝の集計に要る——局面キーだけでは「同じ局面から指された別の手」を区別できない
     * （`moveNumber` は必ず +1 になるので集計単位にならない。prd/10 §5.3）
     */
    move: varchar({ length: 8 }),
    /**
     * 局面キー（SFEN の 盤 / 手番 / 持ち駒）。**手数は含めない**ので手順前後が合流する。
     * ⚠ ハッシュにしない——衝突すると無関係な棋譜が検索結果に混ざり、気づきにくい。
     * 文字列そのものなら衝突せず、URL に載せられ、人が読める（prd/10 §5.1）
     */
    sfen: varchar({ length: 200 }).notNull(),
    /** 先手側だけの配置（盤 + 先手の持ち駒）。相手の駒は空として書く */
    senteSfen: varchar({ length: 200 }).notNull(),
    goteSfen: varchar({ length: 200 }).notNull(),
    /** 盤 81 マス（1 マス 1 バイト）。距離の計算に読む（prd/10 §5.2） */
    board: bytes(81).notNull(),
    /** 持ち駒（先手 7 種 → 後手 7 種の枚数） */
    hands: bytes(14).notNull(),
    sideToMove: mysqlEnum(['b', 'w']).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.kifuId, table.moveNumber] }),
    foreignKey({
      columns: [table.kifuId],
      foreignColumns: [kifus.id],
    }).onDelete('cascade'),
    index('kifu_positions_sfen_idx').on(table.sfen),
    index('kifu_positions_sente_sfen_idx').on(table.senteSfen),
    index('kifu_positions_gote_sfen_idx').on(table.goteSfen),
    // 近い局面の検索は `moveNumber` の範囲で候補を粗く絞る（prd/10 §5.2）。
    // ⚠ **PK は `(kifuId, moveNumber)` なので、この範囲条件には使えない**
    //（先頭列が kifuId のため）。索引が無いと全局面を走査することになる
    index('kifu_positions_move_number_idx').on(table.moveNumber),
  ],
);

export const candidateMoves = mysqlTable(
  'candidate_moves',
  {
    id: serial().primaryKey(),
    moveAnalysisId: bigint({ mode: 'number', unsigned: true })
      .notNull()
      .references(() => moveAnalyses.id, { onDelete: 'cascade' }),
    rank: int().notNull(),
    move: varchar({ length: 255 }).notNull(),
    scoreType: varchar({ length: 16 }).notNull(), // "cp" | "mate"
    scoreValue: int().notNull(),
    pv: json().$type<string[]>(),
    depth: int().notNull(),
  },
  (table) => [
    uniqueIndex('candidate_moves_move_analysis_id_rank_uq').on(
      table.moveAnalysisId,
      table.rank,
    ),
    // 取りこぼし（prd/09 §3.1）の判定は解析済み局面ぶんの候補手を見る。既存の一意索引は
    // `scoreType` / `scoreValue` を含まないため、局面数ぶんの行読み出しになる。
    // mate 行は全体のごく一部なので、この索引で**読む行が mate 行だけに落ちる**（prd/09 §6.2）
    index('candidate_moves_score_idx').on(table.scoreType, table.scoreValue),
  ],
);

export const relations = defineRelations(
  {
    kifus,
    moveAnalyses,
    candidateMoves,
    kifuTactics,
    videoKifuSources,
    kifuPositions,
  },
  (r) => ({
    kifus: {
      moveAnalyses: r.many.moveAnalyses(),
      videoSource: r.one.videoKifuSources({
        from: r.kifus.id,
        to: r.videoKifuSources.kifuId,
      }),
    },
    videoKifuSources: {
      kifu: r.one.kifus({
        from: r.videoKifuSources.kifuId,
        to: r.kifus.id,
      }),
    },
    moveAnalyses: {
      kifu: r.one.kifus({
        from: r.moveAnalyses.kifuId,
        to: r.kifus.id,
      }),
      candidateMoves: r.many.candidateMoves(),
    },
    candidateMoves: {
      moveAnalysis: r.one.moveAnalyses({
        from: r.candidateMoves.moveAnalysisId,
        to: r.moveAnalyses.id,
      }),
    },
  }),
);
