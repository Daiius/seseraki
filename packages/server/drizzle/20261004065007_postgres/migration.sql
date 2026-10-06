CREATE TABLE "account" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" varchar(36) NOT NULL,
	"provider_id" varchar(64) NOT NULL,
	"account_id" varchar(255) NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "candidate_moves" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "candidate_moves_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"move_analysis_id" bigint NOT NULL,
	"rank" integer NOT NULL,
	"move" varchar(255) NOT NULL,
	"score_type" varchar(16) NOT NULL,
	"score_value" integer NOT NULL,
	"pv" jsonb,
	"depth" integer NOT NULL,
	CONSTRAINT "candidate_moves_score_type_check" CHECK ("score_type" in ('cp', 'mate')),
	CONSTRAINT "candidate_moves_rank_positive" CHECK ("rank" >= 1),
	CONSTRAINT "candidate_moves_depth_nonneg" CHECK ("depth" >= 0),
	CONSTRAINT "candidate_moves_pv_array" CHECK (jsonb_typeof("pv") = 'array')
);
--> statement-breakpoint
CREATE TABLE "drill_attempts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "drill_attempts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"drill_id" bigint NOT NULL,
	"move" varchar(16),
	"line" jsonb,
	"verdict" text,
	"loss_cp" integer,
	"excluded" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drill_attempts_verdict_check" CHECK ("verdict" in ('correct', 'close', 'wrong')),
	CONSTRAINT "drill_attempts_line_array" CHECK (jsonb_typeof("line") = 'array')
);
--> statement-breakpoint
CREATE TABLE "drills" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "drills_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kifu_id" bigint NOT NULL,
	"move_number" integer NOT NULL,
	"kind" text NOT NULL,
	"reason" text NOT NULL,
	"answer_move" varchar(16) NOT NULL,
	"answer_score_type" varchar(16) NOT NULL,
	"answer_score_value" integer NOT NULL,
	"answer_pv" jsonb,
	"candidates" jsonb NOT NULL,
	"mate_plies" integer,
	"played_move" varchar(16),
	"played_loss_cp" integer,
	"analysis_revision" integer NOT NULL,
	"blunder_cp" integer NOT NULL,
	"mate_max_plies" integer NOT NULL,
	"generator_rev" varchar(16) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drills_kind_check" CHECK ("kind" in ('mate', 'best')),
	CONSTRAINT "drills_reason_check" CHECK ("reason" in ('missed_mate', 'own_blunder')),
	CONSTRAINT "drills_answer_score_type_check" CHECK ("answer_score_type" in ('cp', 'mate')),
	CONSTRAINT "drills_mate_plies_iff_mate" CHECK (("kind" = 'mate') = ("mate_plies" is not null)),
	CONSTRAINT "drills_candidates_array" CHECK (jsonb_typeof("candidates") = 'array'),
	CONSTRAINT "drills_answer_pv_array" CHECK (jsonb_typeof("answer_pv") = 'array')
);
--> statement-breakpoint
CREATE TABLE "kifu_positions" (
	"kifu_id" bigint,
	"move_number" integer,
	"move" varchar(8),
	"sfen_hash" bytea NOT NULL,
	"sente_sfen_hash" bytea NOT NULL,
	"gote_sfen_hash" bytea NOT NULL,
	"board" bytea NOT NULL,
	"hands" bytea NOT NULL,
	"side_to_move" text NOT NULL,
	CONSTRAINT "kifu_positions_pkey" PRIMARY KEY("kifu_id","move_number"),
	CONSTRAINT "kifu_positions_side_to_move_check" CHECK ("side_to_move" in ('b', 'w')),
	CONSTRAINT "kifu_positions_sfen_hash_len" CHECK (octet_length("sfen_hash") = 8),
	CONSTRAINT "kifu_positions_sente_sfen_hash_len" CHECK (octet_length("sente_sfen_hash") = 8),
	CONSTRAINT "kifu_positions_gote_sfen_hash_len" CHECK (octet_length("gote_sfen_hash") = 8),
	CONSTRAINT "kifu_positions_board_len" CHECK (octet_length("board") = 81),
	CONSTRAINT "kifu_positions_hands_len" CHECK (octet_length("hands") = 14),
	CONSTRAINT "kifu_positions_move_number_nonneg" CHECK ("move_number" >= 0),
	CONSTRAINT "kifu_positions_initial_has_no_move" CHECK (("move_number" = 0) = ("move" is null))
);
--> statement-breakpoint
CREATE TABLE "kifu_tactics" (
	"kifu_id" bigint,
	"side" text,
	"label" varchar(32),
	"turn" integer NOT NULL,
	CONSTRAINT "kifu_tactics_pkey" PRIMARY KEY("kifu_id","side","label"),
	CONSTRAINT "kifu_tactics_side_check" CHECK ("side" in ('sente', 'gote', 'both'))
);
--> statement-breakpoint
CREATE TABLE "kifus" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "kifus_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"title" varchar(255) NOT NULL,
	"kif_text" text NOT NULL,
	"usi_moves" jsonb,
	"sente" varchar(100),
	"gote" varchar(100),
	"sente_dan" smallint,
	"gote_dan" smallint,
	"result" varchar(50),
	"swars_game_key" varchar(255) UNIQUE,
	"played_at" timestamp with time zone,
	"source_tz" varchar(8),
	"analysis_completed_at" timestamp with time zone,
	"analysis_profile" text,
	"analysis_error" text,
	"analysis_revision" integer DEFAULT 0 NOT NULL,
	"memo" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"owner_id" varchar(36) NOT NULL,
	"subject_side" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kifus_analysis_profile_check" CHECK ("analysis_profile" in ('quick', 'full')),
	CONSTRAINT "kifus_source_check" CHECK ("source" in ('manual', 'swars', 'video')),
	CONSTRAINT "kifus_subject_side_check" CHECK ("subject_side" in ('sente', 'gote')),
	CONSTRAINT "kifus_usi_moves_array" CHECK (jsonb_typeof("usi_moves") = 'array'),
	CONSTRAINT "kifus_source_tz_check" CHECK ("source_tz" in ('JST', 'UTC')),
	CONSTRAINT "kifus_analysis_revision_nonneg" CHECK ("analysis_revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "move_analyses" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "move_analyses_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kifu_id" bigint NOT NULL,
	"move_number" integer NOT NULL,
	"profile" text NOT NULL,
	"engine_name" varchar(255),
	"movetime_ms" integer,
	"target_depth" integer,
	"multi_pv" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "move_analyses_profile_check" CHECK ("profile" in ('quick', 'full')),
	CONSTRAINT "move_analyses_move_number_nonneg" CHECK ("move_number" >= 0),
	CONSTRAINT "move_analyses_multi_pv_positive" CHECK ("multi_pv" >= 1)
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid(),
	"token" varchar(255) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_aliases" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "user_aliases_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" varchar(36) NOT NULL,
	"name" varchar(100) NOT NULL,
	"valid_from" date,
	"valid_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_aliases_name_not_empty" CHECK ("name" <> ''),
	CONSTRAINT "user_aliases_valid_range" CHECK ("valid_from" is null or "valid_to" is null or "valid_from" <= "valid_to")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" varchar(255) NOT NULL,
	"email" varchar(255) NOT NULL UNIQUE,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"display_name" varchar(100) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_display_name_not_empty" CHECK ("display_name" <> '')
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid(),
	"identifier" varchar(255) NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "video_kifu_sources" (
	"kifu_id" bigint PRIMARY KEY,
	"video_id" varchar(32) NOT NULL,
	"game_index" integer NOT NULL,
	"started_at_sec" integer NOT NULL,
	"ended_at_sec" integer NOT NULL,
	"bottom_is_sente" boolean NOT NULL,
	"extractor_rev" varchar(40) NOT NULL,
	"raw" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "video_kifu_sources_game_index_nonneg" CHECK ("game_index" >= 0),
	CONSTRAINT "video_kifu_sources_range" CHECK (0 <= "started_at_sec" and "started_at_sec" <= "ended_at_sec")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "account_provider_account_uq" ON "account" ("provider_id","account_id");--> statement-breakpoint
CREATE INDEX "account_user_id_idx" ON "account" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "candidate_moves_move_analysis_id_rank_uq" ON "candidate_moves" ("move_analysis_id","rank");--> statement-breakpoint
CREATE INDEX "candidate_moves_score_idx" ON "candidate_moves" ("score_type","score_value");--> statement-breakpoint
CREATE INDEX "drill_attempts_drill_id_idx" ON "drill_attempts" ("drill_id");--> statement-breakpoint
CREATE INDEX "drill_attempts_created_at_idx" ON "drill_attempts" ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "drills_kifu_id_move_number_kind_uq" ON "drills" ("kifu_id","move_number","kind");--> statement-breakpoint
CREATE INDEX "drills_kind_idx" ON "drills" ("kind");--> statement-breakpoint
CREATE INDEX "kifu_positions_sfen_hash_idx" ON "kifu_positions" ("sfen_hash");--> statement-breakpoint
CREATE INDEX "kifu_positions_sente_sfen_hash_idx" ON "kifu_positions" ("sente_sfen_hash");--> statement-breakpoint
CREATE INDEX "kifu_positions_gote_sfen_hash_idx" ON "kifu_positions" ("gote_sfen_hash");--> statement-breakpoint
CREATE INDEX "kifu_positions_move_number_idx" ON "kifu_positions" ("move_number");--> statement-breakpoint
CREATE INDEX "kifu_tactics_label_idx" ON "kifu_tactics" ("label");--> statement-breakpoint
CREATE INDEX "kifus_analysis_completed_at_idx" ON "kifus" ("analysis_completed_at");--> statement-breakpoint
CREATE INDEX "kifus_source_idx" ON "kifus" ("source");--> statement-breakpoint
CREATE UNIQUE INDEX "move_analyses_kifu_id_move_number_uq" ON "move_analyses" ("kifu_id","move_number");--> statement-breakpoint
CREATE UNIQUE INDEX "session_token_uq" ON "session" ("token");--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "session" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_aliases_name_uq" ON "user_aliases" ("name");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "video_kifu_sources_video_id_game_index_uq" ON "video_kifu_sources" ("video_id","game_index");--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "candidate_moves" ADD CONSTRAINT "candidate_moves_move_analysis_id_move_analyses_id_fkey" FOREIGN KEY ("move_analysis_id") REFERENCES "move_analyses"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "drill_attempts" ADD CONSTRAINT "drill_attempts_drill_id_drills_id_fkey" FOREIGN KEY ("drill_id") REFERENCES "drills"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "drills" ADD CONSTRAINT "drills_kifu_id_kifus_id_fkey" FOREIGN KEY ("kifu_id") REFERENCES "kifus"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "kifu_positions" ADD CONSTRAINT "kifu_positions_kifu_id_kifus_id_fkey" FOREIGN KEY ("kifu_id") REFERENCES "kifus"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "kifu_tactics" ADD CONSTRAINT "kifu_tactics_kifu_id_kifus_id_fkey" FOREIGN KEY ("kifu_id") REFERENCES "kifus"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "kifus" ADD CONSTRAINT "kifus_owner_id_users_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "move_analyses" ADD CONSTRAINT "move_analyses_kifu_id_kifus_id_fkey" FOREIGN KEY ("kifu_id") REFERENCES "kifus"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "user_aliases" ADD CONSTRAINT "user_aliases_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "video_kifu_sources" ADD CONSTRAINT "video_kifu_sources_kifu_id_kifus_id_fkey" FOREIGN KEY ("kifu_id") REFERENCES "kifus"("id") ON DELETE CASCADE;--> statement-breakpoint
-- ============================================================================
-- 🔴 ここから下は手書き（prd/15 §3.4）。**drizzle-kit はトリガーを生成しない。**
-- `updated_at` を持つ表を足したら、その表のトリガーもマイグレーション SQL に手で足す
-- （足し忘れると `updated_at` が作成時刻のまま止まり、何もエラーにならない）。
-- ⚠ `drizzle-kit push` もトリガーを作らないので、dev も migrate に一本化している（db:push は廃止）。
-- ⚠ 列名は DB 上の名前（snake_case。prd/15 §3.6）で書く。TS のプロパティ名（`updatedAt`）ではない。
--
-- MySQL の `ON UPDATE CURRENT_TIMESTAMP` と同じ振る舞いにする:
-- - 行の値が実際に変わったときだけ更新する（同じ値の UPDATE では動かさない）
-- - UPDATE が `updated_at` を明示的に書き換えたときは、その値を尊重する（Better Auth は自分で書く）
-- ============================================================================
CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD AND NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER session_set_updated_at BEFORE UPDATE ON session FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER account_set_updated_at BEFORE UPDATE ON account FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER verification_set_updated_at BEFORE UPDATE ON verification FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER kifus_set_updated_at BEFORE UPDATE ON kifus FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER video_kifu_sources_set_updated_at BEFORE UPDATE ON video_kifu_sources FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER drills_set_updated_at BEFORE UPDATE ON drills FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
-- 所有者の行（ID "1"。prd/11 §6.1・prd/07 §3.1）。MySQL の履歴が作っていた行と同じ形にする
-- （メールは予約ドメインの仮アドレス。本物は移行の付け替え `link-owner-account` で入る。prd/07 §4）。
-- ⚠ MySQL からのデータ移行（prd/15 §6）は users を ID ごと運ぶので、**この仮の行を置き換える**こと。
INSERT INTO users (id, name, email, display_name) VALUES ('1', '(未設定)', 'owner-1@example.invalid', '(未設定)');