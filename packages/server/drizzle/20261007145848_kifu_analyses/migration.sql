CREATE TABLE "kifu_analyses" (
	"kifu_id" bigint PRIMARY KEY,
	"full_count" integer NOT NULL,
	"runs" jsonb NOT NULL,
	"min_mate_sente" integer,
	"min_mate_gote" integer,
	"detail" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kifu_analyses_detail_array" CHECK (jsonb_typeof("detail") = 'array'),
	CONSTRAINT "kifu_analyses_runs_array" CHECK (jsonb_typeof("runs") = 'array'),
	CONSTRAINT "kifu_analyses_full_count_range" CHECK ("full_count" >= 0 and "full_count" <= jsonb_array_length("detail")),
	CONSTRAINT "kifu_analyses_min_mate_sente_positive" CHECK ("min_mate_sente" >= 1),
	CONSTRAINT "kifu_analyses_min_mate_gote_positive" CHECK ("min_mate_gote" >= 1)
);
--> statement-breakpoint
-- ============================================================================
-- ここから下（DROP の前まで）は手で足した（prd/16 §7）。drizzle-kit は圧縮・トリガー・データの詰め替えを生成しない
-- ============================================================================
-- 圧縮は値を書くときに決まるので、詰め替えの INSERT より前に指定する（prd/16 §2 の実測は lz4）
ALTER TABLE "kifu_analyses" ALTER COLUMN "detail" SET COMPRESSION lz4;
--> statement-breakpoint
CREATE TRIGGER kifu_analyses_set_updated_at BEFORE UPDATE ON kifu_analyses FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
-- 前提の確認: 局面が 0 から隙間なく並び、full の局面が先頭からの連続区間であること（prd/16 §4.2・§7）。
-- 崩れている棋譜があれば**黙って詰めずに止める**（トランザクションごと戻る）
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(kifu_id::text, ', ' ORDER BY kifu_id) INTO bad
  FROM (
    SELECT
      kifu_id,
      count(*) AS n,
      min(move_number) AS lo,
      max(move_number) AS hi,
      count(*) FILTER (WHERE profile = 'full') AS nf,
      max(move_number) FILTER (WHERE profile = 'full') AS hif
    FROM move_analyses
    GROUP BY kifu_id
  ) s
  WHERE lo <> 0 OR hi <> n - 1 OR (nf > 0 AND hif <> nf - 1);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'kifu_analyses: 局面が連続していないか、full が先頭からの連続区間でない棋譜がある: %', bad;
  END IF;
  -- 候補手の rank が局面ごとに 1..n の連番であること（prd/16 §7）。詰めた形は rank を配列の位置から
  -- 戻すので、欠番や 1 始まりでない局面を詰めると rank が黙って書き換わる。
  -- 重複は旧表の UNIQUE(move_analysis_id, rank) が防いでいるので、最小 = 1 かつ 最大 = 件数 で連番になる
  SELECT string_agg(DISTINCT ma.kifu_id::text, ', ') INTO bad
  FROM move_analyses ma
  JOIN (
    SELECT move_analysis_id, count(*) AS n, min(rank) AS lo, max(rank) AS hi
    FROM candidate_moves
    GROUP BY move_analysis_id
  ) c ON c.move_analysis_id = ma.id
  WHERE c.lo <> 1 OR c.hi <> c.n;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'kifu_analyses: 候補手の rank が 1 からの連番でない局面を持つ棋譜がある: %', bad;
  END IF;
END
$$;
--> statement-breakpoint
-- 詰め替え（prd/16 §3.1・§7）。
-- - runs: 局面の行を (createdAt, profile, engineName, 解析設定) の組で束ねる。来歴も時刻も失わない
-- - detail[moveNumber] = [run, [[move, scoreType, scoreValue, depth, pv], …]]（rank 順）
-- - minMate*: rank 1 が正の mate の局面の最小値を手番ごとに（`kifu-analysis-detail.ts` の
--   `minMateBySide` と同じ計算。`test:db` が突き合わせる）
WITH positions AS (
  SELECT
    ma.kifu_id,
    ma.move_number,
    ma.profile,
    ma.created_at,
    dense_rank() OVER (
      PARTITION BY ma.kifu_id
      ORDER BY ma.created_at, ma.profile, ma.engine_name, ma.movetime_ms, ma.target_depth, ma.multi_pv
    ) - 1 AS run,
    jsonb_build_object(
      'profile', ma.profile,
      'engineName', ma.engine_name,
      'movetimeMs', ma.movetime_ms,
      'targetDepth', ma.target_depth,
      'multiPv', ma.multi_pv,
      'at', to_char(ma.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ) AS run_body,
    coalesce(
      (
        SELECT jsonb_agg(
          jsonb_build_array(cm.move, cm.score_type, cm.score_value, cm.depth, cm.pv)
          ORDER BY cm.rank
        )
        FROM candidate_moves cm
        WHERE cm.move_analysis_id = ma.id
      ),
      '[]'::jsonb
    ) AS candidates,
    (
      SELECT cm.score_value
      FROM candidate_moves cm
      WHERE cm.move_analysis_id = ma.id
        AND cm.rank = 1
        AND cm.score_type = 'mate'
        AND cm.score_value >= 1
    ) AS self_mate
  FROM move_analyses ma
),
runs AS (
  SELECT DISTINCT kifu_id, run, run_body FROM positions
)
INSERT INTO kifu_analyses (kifu_id, full_count, runs, min_mate_sente, min_mate_gote, detail, created_at, updated_at)
SELECT
  p.kifu_id,
  count(*) FILTER (WHERE p.profile = 'full'),
  (SELECT jsonb_agg(r.run_body ORDER BY r.run) FROM runs r WHERE r.kifu_id = p.kifu_id),
  min(p.self_mate) FILTER (WHERE p.move_number % 2 = 0),
  min(p.self_mate) FILTER (WHERE p.move_number % 2 = 1),
  jsonb_agg(jsonb_build_array(p.run, p.candidates) ORDER BY p.move_number),
  min(p.created_at),
  max(p.created_at)
FROM positions p
GROUP BY p.kifu_id;
--> statement-breakpoint
ALTER TABLE "candidate_moves" DROP CONSTRAINT "candidate_moves_move_analysis_id_move_analyses_id_fkey";--> statement-breakpoint
DROP TABLE "candidate_moves";--> statement-breakpoint
DROP TABLE "move_analyses";--> statement-breakpoint
ALTER TABLE "kifu_analyses" ADD CONSTRAINT "kifu_analyses_kifu_id_kifus_id_fkey" FOREIGN KEY ("kifu_id") REFERENCES "kifus"("id") ON DELETE CASCADE;
