# 開発ガイド

pnpm monorepo。パッケージは `packages/{web,server,worker}`。

## 起動

```bash
pnpm dev          # docker compose watch で全サービス起動（db, server, web, worker）
```

- web: http://localhost:5173
- server: http://localhost:4000
- DB: MySQL 8.4（named volume で永続。`docker compose down -v` で初期化）
- ファイル変更は docker watch の `sync+restart` で自動同期・再起動。`pnpm-lock.yaml` 変更時はコンテナ再ビルド

## DB 操作

```bash
pnpm db:migrate   # スキーマ変更を DB に反映（drizzle-kit push --force）
pnpm db:seed      # サンプルデータ投入（初回のみ必要、既存データがあればスキップ）
```

初回セットアップ: `pnpm dev` で起動後、`pnpm db:migrate && pnpm db:seed` を実行。
スキーマ変更時: `pnpm db:migrate` を実行。

環境変数は `.env.*` ファイルで管理（gitignore 対象）。雛形は `.env.*.example` を参照:

| ファイル | 内容 |
|---------|------|
| `.env.database` | MySQL 接続情報 |
| `.env.server` | API_KEY, AUTH_USERNAME, AUTH_PASSWORD, SESSION_SECRET, COOKIE_SECURE, COOKIE_PATH, CORS_ORIGINS, SWARS_SESSION_COOKIE, SWARS_BASE_URL |
| `.env.worker` | ENGINE_*, SERVER_URL, API_KEY, USE_MOCK, POLL_INTERVAL_MS |
| `.env.web` | VITE_API_URL, VITE_SWARS_USER_ID |

注意: Docker の `--env-file` はインラインコメントに対応していない（行頭の `#` のみ）。
値の後ろに `# コメント` を書くと値の一部として扱われるので避けること。

## 型チェック・テスト・ビルド

```bash
pnpm typecheck    # 全パッケージの tsc --noEmit
pnpm build        # 全パッケージのビルド
pnpm --filter server test   # server のユニットテスト（vitest）
pnpm --filter worker test   # worker のユニットテスト（vitest）
```

## パッケージ間の型共有

Hono RPC (`hc<AppType>`) で server → web/worker 間の API 型を共有する。
shared パッケージは作らない（Hono RPC で十分なため）。

server の `package.json` の `exports` で `route.ts` の型を公開し、
web/worker は `"server": "workspace:*"` で devDependencies として参照。

エンドポイントが server 内部ファイルの型を返すと `hc<AppType>(...)` の
推論結果が遠い相対パスを参照して TS2742 が出ることがある。
`type Client = ReturnType<typeof hc<AppType>>` で一旦型を抜き出して
`export const client: Client = hc<AppType>(...)` と付け直すと回避できる。

## Worker のローカル実行

Docker 外で worker を動かす場合は `packages/worker/.env.example` を `.env` にコピー。
`USE_MOCK=true` でエンジンなしのモック動作が可能。

## 仕様

システム仕様・DB スキーマ・API 定義・未実装計画は `SPEC.md` を参照。
