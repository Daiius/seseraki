#!/bin/sh
# RLS を迂回する system ロール（BYPASSRLS）を作る・揃える（prd/15 §2・prd/14 §4「RLS の形」）。
#
# 全員ぶんを扱う経路（worker の報告・動画解析の取り込み・一括処理のエントリ）が DB_SYSTEM_USER で繋ぐ。
# ログインの経路（server ロール。DB_USER）には RLS が効き、ここだけが素通りする。
#
# 🔒 **マイグレーションでは作らない。** BYPASSRLS の付与には superuser が要る（管理ロールには無い）。
#
# 使い方（どれも superuser で流す。冪等なので何度流してもよい）:
# - dev の空の volume: compose の db が /docker-entrypoint-initdb.d から初回だけ流す（10-server-role.sh の後）
# - dev の既存の volume: compose の db コンテナの中で流す（.env.database に DB_SYSTEM_* を足し、db を作り直してから）
#     docker compose exec db sh /docker-entrypoint-initdb.d/20-system-role.sh --check   # 現状を見るだけ
#     docker compose exec db sh /docker-entrypoint-initdb.d/20-system-role.sh           # 作る・揃える
# - 本番: superuser の psql が届く場所で、同じ環境変数を渡して流す（手順は prd/15 §2）
#
# 必要な環境変数:
#   POSTGRES_USER（superuser）・POSTGRES_DB・DB_SYSTEM_USER・DB_SYSTEM_PASSWORD
#   DB_ADMIN_USER（表を作るロール。default privileges の対象。未設定なら POSTGRES_USER）
#
# やること（どれも冪等）:
#   ロールが無ければ作る → LOGIN BYPASSRLS（superuser・DB 作成・ロール作成は持たせない）とパスワードを揃える →
#   server ロールと同じ DML 権限（既存の表・シーケンス + 今後管理ロールが作るものへの default privileges）
#
# 切り戻し: ロールを使う server を止めてから
#   REASSIGN OWNED BY <role> TO <管理ロール>; DROP OWNED BY <role>; DROP ROLE <role>;
#
# ⚠ 初期化ディレクトリのスクリプトは、実行ビットが無いと entrypoint に source される（引数は entrypoint のもの）。
#   `--check` 以外の引数は無視する。
set -eu

: "${POSTGRES_USER:?POSTGRES_USER（superuser）が未設定です}"
: "${POSTGRES_DB:?POSTGRES_DB が未設定です}"
: "${DB_SYSTEM_USER:?DB_SYSTEM_USER（RLS を迂回する system ロール）が未設定です}"
: "${DB_SYSTEM_PASSWORD:?DB_SYSTEM_PASSWORD（system ロール）が未設定です}"

if [ "${1:-}" = "--check" ]; then
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    -v system_user="$DB_SYSTEM_USER" <<'SQL'
\echo '--- system ロール（無ければ 0 行）'
SELECT rolname, rolcanlogin, rolbypassrls, rolsuper, rolcreatedb, rolcreaterole
  FROM pg_roles WHERE rolname = :'system_user';
\echo '--- 表の権限（RLS を掛けた表）'
SELECT c.relname AS table,
       c.relrowsecurity AS rls,
       has_table_privilege(:'system_user', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS dml
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
   AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'system_user')
 ORDER BY 1;
SQL
  exit 0
fi

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  -v system_user="$DB_SYSTEM_USER" \
  -v system_password="$DB_SYSTEM_PASSWORD" \
  -v admin_user="${DB_ADMIN_USER:-$POSTGRES_USER}" \
  -v db_name="$POSTGRES_DB" \
  <<'SQL'
SELECT set_config('seseraki.system_user', :'system_user', false),
       set_config('seseraki.system_password', :'system_password', false),
       set_config('seseraki.admin_user', :'admin_user', false),
       set_config('seseraki.db_name', :'db_name', false);
DO $do$
DECLARE
  r text := current_setting('seseraki.system_user');
  pw text := current_setting('seseraki.system_password');
  a text := current_setting('seseraki.admin_user');
  d text := current_setting('seseraki.db_name');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
    EXECUTE format('CREATE ROLE %I', r);
  END IF;
  EXECUTE format('ALTER ROLE %I LOGIN BYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', r, pw);
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', d, r);
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', r);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', r);
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', r);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', a, r);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I', a, r);
END
$do$;
SQL
