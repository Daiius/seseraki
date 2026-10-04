#!/usr/bin/env bash
set -euo pipefail

# db コンテナ（Postgres）の 5432 を一時的に 127.0.0.1:${DB_FORWARD_PORT:-55432} へ port-forward して <cmd...> を実行する。
#
# 開発 compose では db をホストに常時公開しない（compose 網内のみ）。ホスト実行の
# db ツール（tsx で localhost に繋ぐ pnpm db:migrate:dev / db:seed / *:dev）は、
# 本スクリプト経由で「都度 forward → 実行 → 撤去」する。本番 DB を cloudflared の
# port-forward 越しに操作するのと同じ発想のローカル版。
#
# 仕組み: compose 網に socat コンテナを一時的に挿し、127.0.0.1:${DB_FORWARD_PORT:-55432}
#   → service `db` の 5432 を中継する。コマンド終了（や中断）で socat は自動削除。
#
# 🔴 **ポートはここで 1 か所に決める。** 実行するコマンドには `DB_FORWARD_PORT` を export して渡すので、
#   `*:dev` の scripts は `.env.database` を読んだ後に `DB_HOST=localhost DB_PORT=$DB_FORWARD_PORT` で上書きする
#   （`.env.database` の `DB_PORT` は compose 網内の値で、ホストからの接続には使わない）。
# 🔴 **既定は標準でないポート（55432）。** 5432 はホストの別の Postgres が使っていることがあり、forward が
#   張れないまま localhost:5432 に繋ぐと**無関係な DB を操作しうる**。さらに、待受ポートに**先客がいたら
#   何もせずに止まる**（forward 前に繋がる＝自分の forward ではない）。forward が張れなかったときも止まる。
#
# 使い方:
#   scripts/db-forward.sh <cmd> [args...]
#   例) scripts/db-forward.sh pnpm --filter server exec sh -c '... DB_HOST=localhost ...'
# 環境変数:
#   DB_FORWARD_PORT  ホスト側の待受ポート（既定 55432）。コマンドへもこの値を export する
#   COMPOSE_FILE 等  docker compose の解決はカレント（リポジトリルート）の compose 設定に従う

PORT="${DB_FORWARD_PORT:-55432}"
export DB_FORWARD_PORT="$PORT"

port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

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

# 先客がいれば止まる。ここで繋がるのは自分の forward ではない（別の DB を操作しうる）。
if port_open "$PORT"; then
  echo "127.0.0.1:${PORT} は既に別のプロセスが待ち受けています。DB_FORWARD_PORT で空いているポートを指定してください。" >&2
  exit 1
fi

# socat で 127.0.0.1:PORT -> (net) db:5432 を中継。
FWD_CID="$(docker run -d --rm \
  -p "127.0.0.1:${PORT}:5432" \
  --network "$NET" \
  alpine/socat \
  TCP-LISTEN:5432,fork,reuseaddr TCP:db:5432)"

cleanup() { docker rm -f "$FWD_CID" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

# forward が張れるまで待つ（最大 ~9 秒）。張れなければ止まる（繋がらない先へコマンドを流さない）。
ready=0
for _ in $(seq 1 30); do
  if port_open "$PORT"; then
    ready=1
    break
  fi
  sleep 0.3
done
if [ "$ready" -ne 1 ]; then
  echo "127.0.0.1:${PORT} への forward が張れませんでした。" >&2
  exit 1
fi

# 対象コマンドを実行（終了コードを維持）。
"$@"
