-- ============================================================================
-- 所有者スコープの土台（prd/14 §4・§4.1・prd/15 §11）。
-- kifus 配下の子の表すべてに owner_id を持たせ、親と食い違わないことを複合 FK で DB が保証する。
--
-- 生成した文を並べ替えて、手で次を足した（drizzle-kit は既存行のある表に NOT NULL 列を足す手順・
-- データの埋め戻しを生成しない）:
--   1. owner_id を NULL 可で足す → 2. 親から埋め戻す → 3. NOT NULL にする → 4. 索引・FK を張る
-- Postgres は DDL もトランザクションに入るので、途中で失敗したら丸ごと戻る。
-- ============================================================================
-- 単独の FK を外す（複合 FK に置き換える。ON DELETE CASCADE はそのまま引き継ぐ）
ALTER TABLE "drill_attempts" DROP CONSTRAINT "drill_attempts_drill_id_drills_id_fkey";--> statement-breakpoint
ALTER TABLE "drills" DROP CONSTRAINT "drills_kifu_id_kifus_id_fkey";--> statement-breakpoint
ALTER TABLE "kifu_analyses" DROP CONSTRAINT "kifu_analyses_kifu_id_kifus_id_fkey";--> statement-breakpoint
ALTER TABLE "kifu_positions" DROP CONSTRAINT "kifu_positions_kifu_id_kifus_id_fkey";--> statement-breakpoint
ALTER TABLE "kifu_tactics" DROP CONSTRAINT "kifu_tactics_kifu_id_kifus_id_fkey";--> statement-breakpoint
ALTER TABLE "video_kifu_sources" DROP CONSTRAINT "video_kifu_sources_kifu_id_kifus_id_fkey";--> statement-breakpoint
-- 局面索引の索引は所有者を先頭に置き直す。名前候補の UNIQUE は (user_id, name) に改める
DROP INDEX "kifu_positions_sfen_hash_idx";--> statement-breakpoint
DROP INDEX "kifu_positions_sente_sfen_hash_idx";--> statement-breakpoint
DROP INDEX "kifu_positions_gote_sfen_hash_idx";--> statement-breakpoint
DROP INDEX "kifu_positions_move_number_idx";--> statement-breakpoint
DROP INDEX "user_aliases_name_uq";--> statement-breakpoint
-- 1. 列を NULL 可で足す（生成された文は NOT NULL 付きで、既存行があると落ちる）
ALTER TABLE "drill_attempts" ADD COLUMN "owner_id" varchar(36);--> statement-breakpoint
ALTER TABLE "drills" ADD COLUMN "owner_id" varchar(36);--> statement-breakpoint
ALTER TABLE "kifu_analyses" ADD COLUMN "owner_id" varchar(36);--> statement-breakpoint
ALTER TABLE "kifu_positions" ADD COLUMN "owner_id" varchar(36);--> statement-breakpoint
ALTER TABLE "kifu_tactics" ADD COLUMN "owner_id" varchar(36);--> statement-breakpoint
ALTER TABLE "video_kifu_sources" ADD COLUMN "owner_id" varchar(36);--> statement-breakpoint
-- 2. 親から埋め戻す。外した FK が親の存在を保証していたので、埋まらない行は無い
--    （残れば 3. の NOT NULL で止まる）。drill_attempts は drills を埋めた後に drills から引く
UPDATE "drills" c SET "owner_id" = k."owner_id" FROM "kifus" k WHERE k."id" = c."kifu_id";--> statement-breakpoint
UPDATE "kifu_analyses" c SET "owner_id" = k."owner_id" FROM "kifus" k WHERE k."id" = c."kifu_id";--> statement-breakpoint
UPDATE "kifu_positions" c SET "owner_id" = k."owner_id" FROM "kifus" k WHERE k."id" = c."kifu_id";--> statement-breakpoint
UPDATE "kifu_tactics" c SET "owner_id" = k."owner_id" FROM "kifus" k WHERE k."id" = c."kifu_id";--> statement-breakpoint
UPDATE "video_kifu_sources" c SET "owner_id" = k."owner_id" FROM "kifus" k WHERE k."id" = c."kifu_id";--> statement-breakpoint
UPDATE "drill_attempts" c SET "owner_id" = d."owner_id" FROM "drills" d WHERE d."id" = c."drill_id";--> statement-breakpoint
-- 3. NOT NULL にする
ALTER TABLE "drill_attempts" ALTER COLUMN "owner_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "drills" ALTER COLUMN "owner_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "kifu_analyses" ALTER COLUMN "owner_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "kifu_positions" ALTER COLUMN "owner_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "kifu_tactics" ALTER COLUMN "owner_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "video_kifu_sources" ALTER COLUMN "owner_id" SET NOT NULL;--> statement-breakpoint
-- ============================================================================
-- ここから下は生成された文のまま
-- ============================================================================
CREATE UNIQUE INDEX "drills_id_owner_id_uq" ON "drills" ("id","owner_id");--> statement-breakpoint
CREATE INDEX "kifu_positions_owner_id_sfen_hash_idx" ON "kifu_positions" ("owner_id","sfen_hash");--> statement-breakpoint
CREATE INDEX "kifu_positions_owner_id_sente_sfen_hash_idx" ON "kifu_positions" ("owner_id","sente_sfen_hash");--> statement-breakpoint
CREATE INDEX "kifu_positions_owner_id_gote_sfen_hash_idx" ON "kifu_positions" ("owner_id","gote_sfen_hash");--> statement-breakpoint
CREATE INDEX "kifu_positions_owner_id_move_number_idx" ON "kifu_positions" ("owner_id","move_number");--> statement-breakpoint
CREATE UNIQUE INDEX "kifus_id_owner_id_uq" ON "kifus" ("id","owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_aliases_user_id_name_uq" ON "user_aliases" ("user_id","name");--> statement-breakpoint
ALTER TABLE "drill_attempts" ADD CONSTRAINT "drill_attempts_drill_owner_fkey" FOREIGN KEY ("drill_id","owner_id") REFERENCES "drills"("id","owner_id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "drills" ADD CONSTRAINT "drills_kifu_owner_fkey" FOREIGN KEY ("kifu_id","owner_id") REFERENCES "kifus"("id","owner_id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "kifu_analyses" ADD CONSTRAINT "kifu_analyses_kifu_owner_fkey" FOREIGN KEY ("kifu_id","owner_id") REFERENCES "kifus"("id","owner_id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "kifu_positions" ADD CONSTRAINT "kifu_positions_kifu_owner_fkey" FOREIGN KEY ("kifu_id","owner_id") REFERENCES "kifus"("id","owner_id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "kifu_tactics" ADD CONSTRAINT "kifu_tactics_kifu_owner_fkey" FOREIGN KEY ("kifu_id","owner_id") REFERENCES "kifus"("id","owner_id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "video_kifu_sources" ADD CONSTRAINT "video_kifu_sources_kifu_owner_fkey" FOREIGN KEY ("kifu_id","owner_id") REFERENCES "kifus"("id","owner_id") ON DELETE CASCADE ON UPDATE CASCADE;
