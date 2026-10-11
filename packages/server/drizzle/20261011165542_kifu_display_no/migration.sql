-- ============================================================================
-- URL に出す棋譜の ID を所有者ごとの番号にする（prd/14 §4.4）。
--
-- 生成した文を並べ替えて、手で次を足した（drizzle-kit は既存行のある表に NOT NULL 列を足す手順・
-- データの埋め戻しを生成しない）:
--   1. display_no を NULL 可で足す → 2. 埋め戻す → 3. NOT NULL にする → 4. 索引・CHECK を張る
-- Postgres は DDL もトランザクションに入るので、途中で失敗したら丸ごと戻る。
-- ============================================================================
-- 1. 列を足す（display_no は NULL 可で。生成された文は NOT NULL 付きで、既存行があると落ちる）
ALTER TABLE "kifus" ADD COLUMN "display_no" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_kifu_no" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- 2. 埋め戻す。🔒 既存の棋譜はすべて所有者（"1"）のもの（新規登録を開く前。prd/14 §4.4）なので、
--    **display_no = id** で埋める。今の URL（/kifus/<id>）がそのまま同じ棋譜を指す。
--    id は全体で一意なので、仮に所有者以外の棋譜があっても所有者ごとの一意は崩れない。
--    カウンタは所有者ごとの max(display_no) に揃える（次の取り込みは max + 1 から。所有者は下の補正も）。
--    🔴 埋め戻しの間は updated_at のトリガーを止める（owner_scope のマイグレーションと同じ扱い。
--    止めないと全棋譜・ユーザーの updated_at が移行時刻に変わる）。同じトランザクションの中で戻す
ALTER TABLE "kifus" DISABLE TRIGGER "kifus_set_updated_at";--> statement-breakpoint
ALTER TABLE "users" DISABLE TRIGGER "users_set_updated_at";--> statement-breakpoint
UPDATE "kifus" SET "display_no" = "id";--> statement-breakpoint
UPDATE "users" u SET "last_kifu_no" = m."last_no"
  FROM (SELECT "owner_id", max("display_no") AS "last_no" FROM "kifus" GROUP BY "owner_id") m
  WHERE m."owner_id" = u."id";--> statement-breakpoint
--    🔴 所有者（"1"）のカウンタは、**kifus.id の identity が既に発行した番号**以上にする（レビュー OCL-7F7C1CC7）。
--    移行前に末尾の棋譜を消していると max(display_no) はそれより小さく、消した棋譜の番号（＝今の URL）を
--    次の取り込みが再利用してしまう。消された棋譜はすべて所有者のもの（新規登録を開く前）なので所有者にだけ当てる
UPDATE "users" SET "last_kifu_no" = greatest(
    "last_kifu_no",
    coalesce((SELECT s."last_value" FROM pg_sequences s
              WHERE format('%I.%I', s."schemaname", s."sequencename") = pg_get_serial_sequence('"kifus"', 'id')), 0)
  )
  WHERE "id" = '1';--> statement-breakpoint
ALTER TABLE "kifus" ENABLE TRIGGER "kifus_set_updated_at";--> statement-breakpoint
ALTER TABLE "users" ENABLE TRIGGER "users_set_updated_at";--> statement-breakpoint
-- 3. NOT NULL にする
ALTER TABLE "kifus" ALTER COLUMN "display_no" SET NOT NULL;--> statement-breakpoint
-- ============================================================================
-- ここから下は生成された文のまま
-- ============================================================================
CREATE UNIQUE INDEX "kifus_owner_id_display_no_uq" ON "kifus" ("owner_id","display_no");--> statement-breakpoint
ALTER TABLE "kifus" ADD CONSTRAINT "kifus_display_no_positive" CHECK ("display_no" > 0);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_last_kifu_no_nonneg" CHECK ("last_kifu_no" >= 0);
