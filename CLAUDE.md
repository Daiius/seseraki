# 開発ガイド

pnpm monorepo。パッケージは `packages/{web,server,worker}`。

## 起動

```bash
pnpm dev          # docker compose watch で全サービス起動（db, server, web, worker）
```

- web: http://localhost:5173
- server: http://localhost:4000
- DB: MySQL 8.4（tmpfs、データ揮発）
- ファイル変更は docker watch で自動同期。`pnpm-lock.yaml` 変更時はコンテナ再ビルド

DB 接続情報は `.env.database`（gitignore 対象外、開発用固定値）。

## 型チェック・ビルド

```bash
pnpm typecheck    # 全パッケージの tsc --noEmit
pnpm build        # 全パッケージのビルド
```

## パッケージ間の型共有

Hono RPC (`hc<AppType>`) で server → web/worker 間の API 型を共有する。
shared パッケージは作らない（Hono RPC で十分なため）。

server の `package.json` の `exports` で `route.ts` の型を公開し、
web/worker は `"server": "workspace:*"` で devDependencies として参照。

## Worker のローカル実行

Docker 外で worker を動かす場合は `packages/worker/.env.example` を `.env` にコピー。
`USE_MOCK=true` でエンジンなしのモック動作が可能。

## 仕様

システム仕様・DB スキーマ・API 定義・未実装計画は `SPEC.md` を参照。
