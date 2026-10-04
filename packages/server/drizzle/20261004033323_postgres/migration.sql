CREATE TABLE "account" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid(),
	"userId" varchar(36) NOT NULL,
	"providerId" varchar(64) NOT NULL,
	"accountId" varchar(255) NOT NULL,
	"accessToken" text,
	"refreshToken" text,
	"idToken" text,
	"accessTokenExpiresAt" timestamp with time zone,
	"refreshTokenExpiresAt" timestamp with time zone,
	"scope" text,
	"password" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "candidate_moves" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "candidate_moves_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"moveAnalysisId" bigint NOT NULL,
	"rank" integer NOT NULL,
	"move" varchar(255) NOT NULL,
	"scoreType" varchar(16) NOT NULL,
	"scoreValue" integer NOT NULL,
	"pv" jsonb,
	"depth" integer NOT NULL,
	CONSTRAINT "candidate_moves_score_type_check" CHECK ("scoreType" in ('cp', 'mate')),
	CONSTRAINT "candidate_moves_rank_positive" CHECK ("rank" >= 1),
	CONSTRAINT "candidate_moves_depth_nonneg" CHECK ("depth" >= 0),
	CONSTRAINT "candidate_moves_pv_array" CHECK (jsonb_typeof("pv") = 'array')
);
--> statement-breakpoint
CREATE TABLE "drill_attempts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "drill_attempts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"drillId" bigint NOT NULL,
	"move" varchar(16),
	"line" jsonb,
	"verdict" text,
	"lossCp" integer,
	"excluded" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drill_attempts_verdict_check" CHECK ("verdict" in ('correct', 'close', 'wrong')),
	CONSTRAINT "drill_attempts_line_array" CHECK (jsonb_typeof("line") = 'array')
);
--> statement-breakpoint
CREATE TABLE "drills" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "drills_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kifuId" bigint NOT NULL,
	"moveNumber" integer NOT NULL,
	"kind" text NOT NULL,
	"reason" text NOT NULL,
	"answerMove" varchar(16) NOT NULL,
	"answerScoreType" varchar(16) NOT NULL,
	"answerScoreValue" integer NOT NULL,
	"answerPv" jsonb,
	"candidates" jsonb NOT NULL,
	"matePlies" integer,
	"playedMove" varchar(16),
	"playedLossCp" integer,
	"analysisRevision" integer NOT NULL,
	"blunderCp" integer NOT NULL,
	"mateMaxPlies" integer NOT NULL,
	"generatorRev" varchar(16) NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drills_kind_check" CHECK ("kind" in ('mate', 'best')),
	CONSTRAINT "drills_reason_check" CHECK ("reason" in ('missed_mate', 'own_blunder')),
	CONSTRAINT "drills_answer_score_type_check" CHECK ("answerScoreType" in ('cp', 'mate')),
	CONSTRAINT "drills_mate_plies_iff_mate" CHECK (("kind" = 'mate') = ("matePlies" is not null)),
	CONSTRAINT "drills_candidates_array" CHECK (jsonb_typeof("candidates") = 'array'),
	CONSTRAINT "drills_answer_pv_array" CHECK (jsonb_typeof("answerPv") = 'array')
);
--> statement-breakpoint
CREATE TABLE "kifu_positions" (
	"kifuId" bigint,
	"moveNumber" integer,
	"move" varchar(8),
	"sfenHash" bytea NOT NULL,
	"senteSfenHash" bytea NOT NULL,
	"goteSfenHash" bytea NOT NULL,
	"board" bytea NOT NULL,
	"hands" bytea NOT NULL,
	"sideToMove" text NOT NULL,
	CONSTRAINT "kifu_positions_pkey" PRIMARY KEY("kifuId","moveNumber"),
	CONSTRAINT "kifu_positions_side_to_move_check" CHECK ("sideToMove" in ('b', 'w')),
	CONSTRAINT "kifu_positions_sfen_hash_len" CHECK (octet_length("sfenHash") = 8),
	CONSTRAINT "kifu_positions_sente_sfen_hash_len" CHECK (octet_length("senteSfenHash") = 8),
	CONSTRAINT "kifu_positions_gote_sfen_hash_len" CHECK (octet_length("goteSfenHash") = 8),
	CONSTRAINT "kifu_positions_board_len" CHECK (octet_length("board") = 81),
	CONSTRAINT "kifu_positions_hands_len" CHECK (octet_length("hands") = 14),
	CONSTRAINT "kifu_positions_move_number_nonneg" CHECK ("moveNumber" >= 0),
	CONSTRAINT "kifu_positions_initial_has_no_move" CHECK (("moveNumber" = 0) = ("move" is null))
);
--> statement-breakpoint
CREATE TABLE "kifu_tactics" (
	"kifuId" bigint,
	"side" text,
	"label" varchar(32),
	"turn" integer NOT NULL,
	CONSTRAINT "kifu_tactics_pkey" PRIMARY KEY("kifuId","side","label"),
	CONSTRAINT "kifu_tactics_side_check" CHECK ("side" in ('sente', 'gote', 'both'))
);
--> statement-breakpoint
CREATE TABLE "kifus" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "kifus_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"title" varchar(255) NOT NULL,
	"kifText" text NOT NULL,
	"usiMoves" jsonb,
	"sente" varchar(100),
	"gote" varchar(100),
	"senteDan" smallint,
	"goteDan" smallint,
	"result" varchar(50),
	"swarsGameKey" varchar(255) UNIQUE,
	"playedAt" timestamp with time zone,
	"sourceTz" varchar(8),
	"analysisCompletedAt" timestamp with time zone,
	"analysisProfile" text,
	"analysisError" text,
	"analysisRevision" integer DEFAULT 0 NOT NULL,
	"memo" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"ownerId" varchar(36) NOT NULL,
	"subjectSide" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kifus_analysis_profile_check" CHECK ("analysisProfile" in ('quick', 'full')),
	CONSTRAINT "kifus_source_check" CHECK ("source" in ('manual', 'swars', 'video')),
	CONSTRAINT "kifus_subject_side_check" CHECK ("subjectSide" in ('sente', 'gote')),
	CONSTRAINT "kifus_usi_moves_array" CHECK (jsonb_typeof("usiMoves") = 'array'),
	CONSTRAINT "kifus_source_tz_check" CHECK ("sourceTz" in ('JST', 'UTC')),
	CONSTRAINT "kifus_analysis_revision_nonneg" CHECK ("analysisRevision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "move_analyses" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "move_analyses_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kifuId" bigint NOT NULL,
	"moveNumber" integer NOT NULL,
	"profile" text NOT NULL,
	"engineName" varchar(255),
	"movetimeMs" integer,
	"targetDepth" integer,
	"multiPv" integer,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "move_analyses_profile_check" CHECK ("profile" in ('quick', 'full')),
	CONSTRAINT "move_analyses_move_number_nonneg" CHECK ("moveNumber" >= 0),
	CONSTRAINT "move_analyses_multi_pv_positive" CHECK ("multiPv" >= 1)
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid(),
	"token" varchar(255) NOT NULL,
	"userId" varchar(36) NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"ipAddress" text,
	"userAgent" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_aliases" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "user_aliases_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"userId" varchar(36) NOT NULL,
	"name" varchar(100) NOT NULL,
	"validFrom" date,
	"validTo" date,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_aliases_name_not_empty" CHECK ("name" <> ''),
	CONSTRAINT "user_aliases_valid_range" CHECK ("validFrom" is null or "validTo" is null or "validFrom" <= "validTo")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" varchar(255) NOT NULL,
	"email" varchar(255) NOT NULL UNIQUE,
	"emailVerified" boolean DEFAULT false NOT NULL,
	"image" text,
	"displayName" varchar(100) NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_display_name_not_empty" CHECK ("displayName" <> '')
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid(),
	"identifier" varchar(255) NOT NULL,
	"value" text NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "video_kifu_sources" (
	"kifuId" bigint PRIMARY KEY,
	"videoId" varchar(32) NOT NULL,
	"gameIndex" integer NOT NULL,
	"startedAtSec" integer NOT NULL,
	"endedAtSec" integer NOT NULL,
	"bottomIsSente" boolean NOT NULL,
	"extractorRev" varchar(40) NOT NULL,
	"raw" jsonb NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "video_kifu_sources_game_index_nonneg" CHECK ("gameIndex" >= 0),
	CONSTRAINT "video_kifu_sources_range" CHECK (0 <= "startedAtSec" and "startedAtSec" <= "endedAtSec")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "account_provider_account_uq" ON "account" ("providerId","accountId");--> statement-breakpoint
CREATE INDEX "account_user_id_idx" ON "account" ("userId");--> statement-breakpoint
CREATE UNIQUE INDEX "candidate_moves_move_analysis_id_rank_uq" ON "candidate_moves" ("moveAnalysisId","rank");--> statement-breakpoint
CREATE INDEX "candidate_moves_score_idx" ON "candidate_moves" ("scoreType","scoreValue");--> statement-breakpoint
CREATE INDEX "drill_attempts_drill_id_idx" ON "drill_attempts" ("drillId");--> statement-breakpoint
CREATE INDEX "drill_attempts_created_at_idx" ON "drill_attempts" ("createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "drills_kifu_id_move_number_kind_uq" ON "drills" ("kifuId","moveNumber","kind");--> statement-breakpoint
CREATE INDEX "drills_kind_idx" ON "drills" ("kind");--> statement-breakpoint
CREATE INDEX "kifu_positions_sfen_hash_idx" ON "kifu_positions" ("sfenHash");--> statement-breakpoint
CREATE INDEX "kifu_positions_sente_sfen_hash_idx" ON "kifu_positions" ("senteSfenHash");--> statement-breakpoint
CREATE INDEX "kifu_positions_gote_sfen_hash_idx" ON "kifu_positions" ("goteSfenHash");--> statement-breakpoint
CREATE INDEX "kifu_positions_move_number_idx" ON "kifu_positions" ("moveNumber");--> statement-breakpoint
CREATE INDEX "kifu_tactics_label_idx" ON "kifu_tactics" ("label");--> statement-breakpoint
CREATE INDEX "kifus_analysis_completed_at_idx" ON "kifus" ("analysisCompletedAt");--> statement-breakpoint
CREATE INDEX "kifus_source_idx" ON "kifus" ("source");--> statement-breakpoint
CREATE UNIQUE INDEX "move_analyses_kifu_id_move_number_uq" ON "move_analyses" ("kifuId","moveNumber");--> statement-breakpoint
CREATE UNIQUE INDEX "session_token_uq" ON "session" ("token");--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "session" ("userId");--> statement-breakpoint
CREATE UNIQUE INDEX "user_aliases_name_uq" ON "user_aliases" ("name");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "video_kifu_sources_video_id_game_index_uq" ON "video_kifu_sources" ("videoId","gameIndex");--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_userId_users_id_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "candidate_moves" ADD CONSTRAINT "candidate_moves_moveAnalysisId_move_analyses_id_fkey" FOREIGN KEY ("moveAnalysisId") REFERENCES "move_analyses"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "drill_attempts" ADD CONSTRAINT "drill_attempts_drillId_drills_id_fkey" FOREIGN KEY ("drillId") REFERENCES "drills"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "drills" ADD CONSTRAINT "drills_kifuId_kifus_id_fkey" FOREIGN KEY ("kifuId") REFERENCES "kifus"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "kifu_positions" ADD CONSTRAINT "kifu_positions_kifuId_kifus_id_fkey" FOREIGN KEY ("kifuId") REFERENCES "kifus"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "kifu_tactics" ADD CONSTRAINT "kifu_tactics_kifuId_kifus_id_fkey" FOREIGN KEY ("kifuId") REFERENCES "kifus"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "kifus" ADD CONSTRAINT "kifus_ownerId_users_id_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "move_analyses" ADD CONSTRAINT "move_analyses_kifuId_kifus_id_fkey" FOREIGN KEY ("kifuId") REFERENCES "kifus"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_userId_users_id_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "user_aliases" ADD CONSTRAINT "user_aliases_userId_users_id_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "video_kifu_sources" ADD CONSTRAINT "video_kifu_sources_kifuId_kifus_id_fkey" FOREIGN KEY ("kifuId") REFERENCES "kifus"("id") ON DELETE CASCADE;--> statement-breakpoint
-- ============================================================================
-- 🔴 ここから下は手書き（prd/15 §3.4）。**drizzle-kit はトリガーを生成しない。**
-- `updatedAt` を持つ表を足したら、その表のトリガーもマイグレーション SQL に手で足す
-- （足し忘れると `updatedAt` が作成時刻のまま止まり、何もエラーにならない）。
-- ⚠ `drizzle-kit push` もトリガーを作らないので、dev も migrate に一本化している（db:push は廃止）。
--
-- MySQL の `ON UPDATE CURRENT_TIMESTAMP` と同じ振る舞いにする:
-- - 行の値が実際に変わったときだけ更新する（同じ値の UPDATE では動かさない）
-- - UPDATE が `updatedAt` を明示的に書き換えたときは、その値を尊重する（Better Auth は自分で書く）
-- ============================================================================
CREATE FUNCTION "set_updated_at"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD AND NEW."updatedAt" IS NOT DISTINCT FROM OLD."updatedAt" THEN
    NEW."updatedAt" := now();
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "users_set_updated_at" BEFORE UPDATE ON "users" FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();
--> statement-breakpoint
CREATE TRIGGER "session_set_updated_at" BEFORE UPDATE ON "session" FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();
--> statement-breakpoint
CREATE TRIGGER "account_set_updated_at" BEFORE UPDATE ON "account" FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();
--> statement-breakpoint
CREATE TRIGGER "verification_set_updated_at" BEFORE UPDATE ON "verification" FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();
--> statement-breakpoint
CREATE TRIGGER "kifus_set_updated_at" BEFORE UPDATE ON "kifus" FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();
--> statement-breakpoint
CREATE TRIGGER "video_kifu_sources_set_updated_at" BEFORE UPDATE ON "video_kifu_sources" FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();
--> statement-breakpoint
CREATE TRIGGER "drills_set_updated_at" BEFORE UPDATE ON "drills" FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();
--> statement-breakpoint
-- 所有者の行（ID "1"。prd/11 §6.1・prd/07 §3.1）。MySQL の履歴が作っていた行と同じ形にする
-- （メールは予約ドメインの仮アドレス。本物は移行の付け替え `link-owner-account` で入る。prd/07 §4）。
-- ⚠ MySQL からのデータ移行（prd/15 §6）は users を ID ごと運ぶので、**この仮の行を置き換える**こと。
INSERT INTO "users" ("id", "name", "email", "displayName") VALUES ('1', '(未設定)', 'owner-1@example.invalid', '(未設定)');