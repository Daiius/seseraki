# リモート dev 環境の公開

常駐マシン上の dev スタック（`docker compose` の Vite dev）を、前段プロキシ
（例: Cloudflare Tunnel + Access）越しに手元ブラウザから使うための構成メモ。

## 方針: ローカルと同一の compose を env で切替える

**ローカル dev と remote で compose / vite 設定を分けない。** 単一の `compose.yml` と
`vite.config.ts` を環境変数でパラメータ化し、remote 差分は `.env.remote` だけに集約する
（`.env.remote.example` 参照）。

remote と local の差は次の3点のみで、すべて env 由来:

| 差分                  | ローカル既定   | remote（.env.remote）          | 効かせ方                                       |
| --------------------- | -------------- | ------------------------------ | ---------------------------------------------- |
| web の公開バインド    | `5173`（全IF） | `127.0.0.1:8101`               | compose `${WEB_BIND}`                          |
| secure cookie         | `false`        | `true`                         | compose `${COOKIE_SECURE}` → server            |
| Vite の許可ホスト/HMR | なし           | `allowedHosts` + `hmr wss:443` | `${DEV_ALLOWED_HOST}` を vite.config.ts が判定 |

ブラウザは web(Vite) の `/api` proxy 経由で server に届き（`DEV_API_TARGET=http://server:4000`）、
compose 内 worker も compose 網内で `server:4000` に繋ぐ。ホスト公開は次の方針:

- **db**: ホストに公開しない。ホスト実行の db ツールは `scripts/db-forward.sh` が都度 forward（後述）。
- **server**: ホストに公開しない。ブラウザ・compose 内 worker は `/api` proxy／compose 網で server に届く。
  Docker 外 worker を使う場合は `SERVER_URL` を web の `/api` proxy（`http://localhost:5173`）へ（prd/02 §6）。
- **web**: 唯一の外向き口（local `5173` / remote `127.0.0.1:${WEB_BIND のポート}`）。

## 起動

```bash
# ローカル dev（従来どおり）
pnpm dev

# remote 公開（.env.remote を用意して）
cp .env.remote.example .env.remote   # 値を埋める（gitignore 対象）
docker compose --env-file .env.remote up -d --build
docker compose --env-file .env.remote watch   # 別ターミナル: 編集→同期→HMR
```

前段プロキシ（Cloudflare Tunnel の ingress を `http://localhost:${WEB_BIND のポート}` へ、
Access で許可メール限定 等）の具体設定と実ドメインは公開しない（各自の環境／`.claude-personal/`）。

## DB 操作（ホストに db ポートを出さない構成での使い方）

db をホスト公開しないため、ホスト実行の db ツールは `scripts/db-forward.sh` が
**都度 port-forward（socat で 127.0.0.1:3306 → `db:3306`）して実行し、終了時に撤去**する。
`pnpm db:*`（localhost 系）はこのラッパー込みで定義済みなので、**従来どおり一発で動く**:

```bash
pnpm db:push        # スキーマ強制同期（forward 経由）
pnpm db:seed        # サンプル投入（forward 経由）
pnpm db:migrate:dev # 未適用マイグレーション適用（forward 経由）
```

本番 DB 向け（`db:migrate` / `db:baseline` / `db:generate`）は接続先を呼び出し環境の
`DB_HOST` から取る別系統で、forward ラッパーは通さない。
