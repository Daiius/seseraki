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
#
# 🔒 **パスワードをどこにも表示・記録しない**（レビュー OCL-D6CF61B0）:
#   - コマンドライン（`ps` で見える）に載せない。psql の `\getenv`（psql 15 以降）で環境変数から psql 変数へ読む
#   - 標準出力に出さない。値を受け渡す SELECT の結果は `\o /dev/null` に捨て、`-q` で状態表示も出さない。
#     失敗時も `VERBOSITY terse` で CONTEXT（EXECUTE した SQL＝パスワードを含む）を出さない
#   - サーバーのログに出さない。このセッションだけ log_statement 等を止める（superuser の権限で SET できる）
#   - psql の履歴: heredoc（非対話）なので履歴ファイルには書かない
#   - 受け渡しのセッション変数は `set_config(…, true)`（トランザクションの間だけ）で、COMMIT で消える
#   ⚠ 残る経路: pg_stat_statements を入れていて `track_utility` が有効なら ALTER ROLE の文が統計に載りうる
#   （このリポジトリの構成では入れていない）。Postgres に平文で送る以上、サーバー側の拡張までは止められない
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

psql -v ON_ERROR_STOP=1 -q \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  -v system_user="$DB_SYSTEM_USER" \
  -v admin_user="${DB_ADMIN_USER:-$POSTGRES_USER}" \
  -v db_name="$POSTGRES_DB" \
  <<'SQL'
\getenv system_password DB_SYSTEM_PASSWORD
\set VERBOSITY terse
-- パスワードを含む文をサーバーのログに残さない（このセッションだけ。設定には superuser が要る）。
-- log_statement=all などの設定でも文を出さず、失敗したときも文と CONTEXT（EXECUTE した SQL）を出さない
SET log_statement = 'none';
SET log_min_duration_statement = -1;
SET log_min_error_statement = 'panic';
SET log_error_verbosity = 'terse';
BEGIN;
\o /dev/null
SELECT set_config('seseraki.system_user', :'system_user', true),
       set_config('seseraki.system_password', :'system_password', true),
       set_config('seseraki.admin_user', :'admin_user', true),
       set_config('seseraki.db_name', :'db_name', true);
\o
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
COMMIT;
SQL
