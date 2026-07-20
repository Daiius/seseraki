#!/usr/bin/env bash
set -euo pipefail

# db コンテナの 3306 を一時的に 127.0.0.1 へ port-forward して <cmd...> を実行する。
#
# 開発 compose では db をホストに常時公開しない（compose 網内のみ）。ホスト実行の
# db ツール（drizzle-kit / tsx で localhost:3306 に繋ぐ pnpm db:push / db:seed / *:dev）は、
# 本スクリプト経由で「都度 forward → 実行 → 撤去」する。本番 DB を cloudflared の
# port-forward 越しに操作するのと同じ発想のローカル版。
#
# 仕組み: compose 網に socat コンテナを一時的に挿し、127.0.0.1:${DB_FORWARD_PORT:-3306}
#   → service `db` の 3306 を中継する。コマンド終了（や中断）で socat は自動削除。
#
# 使い方:
#   scripts/db-forward.sh <cmd> [args...]
#   例) scripts/db-forward.sh pnpm --filter server exec sh -c '... DB_HOST=localhost ...'
# 環境変数:
#   DB_FORWARD_PORT  ホスト側の待受ポート（既定 3306。db ツールは 3306 前提なので通常は既定）
#   COMPOSE_FILE 等  docker compose の解決はカレント（リポジトリルート）の compose 設定に従う

PORT="${DB_FORWARD_PORT:-3306}"

if [ "$#" -eq 0 ]; then
  echo "usage: scripts/db-forward.sh <cmd> [args...]" >&2
  exit 2
fi

# 稼働中の db コンテナと、その所属ネットワークを取得（COMPOSE_PROJECT_NAME 等を尊重）。
DB_CID="$(docker compose ps -q db 2>/dev/null || true)"
if [ -z "$DB_CID" ]; then
  echo "db コンテナが起動していません。先に 'pnpm dev'（または docker compose up）で起動してください。" >&2
  exit 1
fi
NET="$(docker inspect "$DB_CID" \
  --format '{{range $k, $_ := .NetworkSettings.Networks}}{{$k}}{{end}}')"
if [ -z "$NET" ]; then
  echo "db コンテナのネットワークを特定できませんでした。" >&2
  exit 1
fi

# socat で 127.0.0.1:PORT -> (net) db:3306 を中継。
FWD_CID="$(docker run -d --rm \
  -p "127.0.0.1:${PORT}:3306" \
  --network "$NET" \
  alpine/socat \
  TCP-LISTEN:3306,fork,reuseaddr TCP:db:3306)"

cleanup() { docker rm -f "$FWD_CID" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

# forward が張れるまで待つ（最大 ~9 秒）。
for _ in $(seq 1 30); do
  if (exec 3<>"/dev/tcp/127.0.0.1/${PORT}") 2>/dev/null; then
    exec 3>&- 3<&-
    break
  fi
  sleep 0.3
done

# 対象コマンドを実行（終了コードを維持）。
"$@"
