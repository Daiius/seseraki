-- ============================================================================
-- 解析の担当（worker / browser）をユーザーごとに持つ（prd/14 §5.7）。
--
-- 生成した文に、手で次を足した（drizzle-kit はデータの埋め戻しを生成しない）:
--   1. 列を足す（既定は browser）→ 2. 既存の所有者の行だけ worker に埋め戻す → 3. CHECK を張る
-- Postgres は DDL もトランザクションに入るので、途中で失敗したら丸ごと戻る。
-- ============================================================================
-- 1. 列を足す（生成された文のまま。既存の行は既定値の browser で埋まる。トリガーは走らない）
ALTER TABLE "users" ADD COLUMN "analysis_assignee" text DEFAULT 'browser' NOT NULL;--> statement-breakpoint
-- 2. 🔒 既存の所有者（"1"）の行だけ worker にする。今の本番は全棋譜を手元 worker が解析しているので、
--    このマイグレーションの前後で挙動を変えない（browser のままだと、新しい server の poll が所有者の棋譜を返さなくなる）。
--    所有者の行が無い DATABASE では 0 行（何もしない）。
--    🔴 埋め戻しの間は updated_at のトリガーを止める（kifu_display_no のマイグレーションと同じ扱い。
--    止めないと所有者の updated_at が移行時刻に変わる）。同じトランザクションの中で戻す
ALTER TABLE "users" DISABLE TRIGGER "users_set_updated_at";--> statement-breakpoint
UPDATE "users" SET "analysis_assignee" = 'worker' WHERE "id" = '1';--> statement-breakpoint
ALTER TABLE "users" ENABLE TRIGGER "users_set_updated_at";--> statement-breakpoint
-- ============================================================================
-- 3. ここから下は生成された文のまま（worker を選べるのは所有者だけ、を DB でも守る）
-- ============================================================================
ALTER TABLE "users" ADD CONSTRAINT "users_analysis_assignee_check" CHECK ("analysis_assignee" in ('worker', 'browser'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_analysis_assignee_worker_owner_only" CHECK ("analysis_assignee" <> 'worker' or "id" = '1');
