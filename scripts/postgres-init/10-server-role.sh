#!/bin/sh
# dev の Postgres の初期化（compose の db が /docker-entrypoint-initdb.d から**空の volume の初回だけ**流す）。
#
# ロールを 2 つに分ける（prd/15 §2）:
# - 管理ロール … POSTGRES_USER（公式イメージが作る。DDL・マイグレーション）。アプリは DB_ADMIN_USER として使う
# - server ロール … DB_USER（ここで作る。DML のみ。常駐の server と一括処理）
#
# server ロールには**テーブルを作る権限を渡さない**（Postgres 15 以降は public スキーマの CREATE が既定で無い）。
# 表はマイグレーション（管理ロール）が後から作るので、**default privileges** で「管理ロールが作る表・
# シーケンスには server ロールの DML 権限を付ける」と先に宣言しておく。
#
# ⚠ 既存の volume には流れない。ロールを作り直したいときは volume を消して作り直す（dev のデータは消える）。
# ⚠ DB_ADMIN_USER は POSTGRES_USER と同じ名前にする（default privileges は「誰が作った表か」で効く）。
set -eu

: "${DB_USER:?DB_USER（server ロール）が未設定です}"
: "${DB_PASSWORD:?DB_PASSWORD（server ロール）が未設定です}"

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  -v server_user="$DB_USER" \
  -v server_password="$DB_PASSWORD" \
  -v admin_user="$POSTGRES_USER" \
  -v db_name="$POSTGRES_DB" \
  <<'SQL'
CREATE ROLE :"server_user" LOGIN PASSWORD :'server_password';
GRANT CONNECT ON DATABASE :"db_name" TO :"server_user";
GRANT USAGE ON SCHEMA public TO :"server_user";
ALTER DEFAULT PRIVILEGES FOR ROLE :"admin_user" IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"server_user";
ALTER DEFAULT PRIVILEGES FOR ROLE :"admin_user" IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO :"server_user";
SQL
