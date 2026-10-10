-- ============================================================================
-- 所有者スコープの RLS（prd/14 §4「RLS の形」・prd/15 §11 の 2）。生成された文のまま（schema.ts の `ownerPolicy`）。
--
-- kifus と子の表 6 つは owner_id、user_aliases は user_id を `current_setting('app.user_id', true)` と比べる。
-- USING と WITH CHECK の両方（他人の行は読めず、他人の所有者で書けない）。未設定なら 0 件（fail-closed）。
-- ログインの経路（server ロール）は `user-tx.ts` が tx ごとに app.user_id を入れる。
-- 全員ぶんの経路（worker・一括処理）は BYPASSRLS の system ロールで繋ぐ（ロールは migration では作らない）。
--
-- ⚠ FORCE ROW LEVEL SECURITY は付けない。表の所有者（このマイグレーションを流す管理ロール）にまで効くと、
--   今後のマイグレーションの埋め戻し（UPDATE … FROM kifus など）が app.user_id 未設定で**黙って 0 行**になる。
--   アプリは表の所有者で繋がない（prd/15 §2）ので、FORCE が無くてもアプリの経路はすべて RLS の下にある。
-- ============================================================================
ALTER TABLE "drill_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "drills" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kifu_analyses" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kifu_positions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kifu_tactics" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kifus" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_aliases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "video_kifu_sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "owner_scope" ON "drill_attempts" AS PERMISSIVE FOR ALL TO public USING ("drill_attempts"."owner_id" = current_setting('app.user_id', true)) WITH CHECK ("drill_attempts"."owner_id" = current_setting('app.user_id', true));--> statement-breakpoint
CREATE POLICY "owner_scope" ON "drills" AS PERMISSIVE FOR ALL TO public USING ("drills"."owner_id" = current_setting('app.user_id', true)) WITH CHECK ("drills"."owner_id" = current_setting('app.user_id', true));--> statement-breakpoint
CREATE POLICY "owner_scope" ON "kifu_analyses" AS PERMISSIVE FOR ALL TO public USING ("kifu_analyses"."owner_id" = current_setting('app.user_id', true)) WITH CHECK ("kifu_analyses"."owner_id" = current_setting('app.user_id', true));--> statement-breakpoint
CREATE POLICY "owner_scope" ON "kifu_positions" AS PERMISSIVE FOR ALL TO public USING ("kifu_positions"."owner_id" = current_setting('app.user_id', true)) WITH CHECK ("kifu_positions"."owner_id" = current_setting('app.user_id', true));--> statement-breakpoint
CREATE POLICY "owner_scope" ON "kifu_tactics" AS PERMISSIVE FOR ALL TO public USING ("kifu_tactics"."owner_id" = current_setting('app.user_id', true)) WITH CHECK ("kifu_tactics"."owner_id" = current_setting('app.user_id', true));--> statement-breakpoint
CREATE POLICY "owner_scope" ON "kifus" AS PERMISSIVE FOR ALL TO public USING ("kifus"."owner_id" = current_setting('app.user_id', true)) WITH CHECK ("kifus"."owner_id" = current_setting('app.user_id', true));--> statement-breakpoint
CREATE POLICY "owner_scope" ON "user_aliases" AS PERMISSIVE FOR ALL TO public USING ("user_aliases"."user_id" = current_setting('app.user_id', true)) WITH CHECK ("user_aliases"."user_id" = current_setting('app.user_id', true));--> statement-breakpoint
CREATE POLICY "owner_scope" ON "video_kifu_sources" AS PERMISSIVE FOR ALL TO public USING ("video_kifu_sources"."owner_id" = current_setting('app.user_id', true)) WITH CHECK ("video_kifu_sources"."owner_id" = current_setting('app.user_id', true));