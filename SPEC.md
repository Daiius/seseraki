# Shogi 棋譜解析システム仕様書

スペックの余っているデスクトップ PC で棋譜解析を行う個人開発システム。
TypeScript フルスタック、pnpm monorepo 構成。

## システム構成

```
┌─────────┐     ┌─────────┐     ┌─────────┐
│   web   │────▶│ server  │◀────│ worker  │
│ React   │proxy│ Hono    │API  │ Node.js │
│ Vite    │/api │ Drizzle │KEY  │ USI     │
└─────────┘     └────┬────┘     └────┬────┘
                     │               │
                ┌────▼────┐     ┌────▼────┐
                │  MySQL  │     │yaneuraou│
                └─────────┘     └─────────┘
```

| パッケージ | 役割 | 主要技術 |
|-----------|------|---------|
| web | 棋譜管理 UI | React 19, Vite 8, TanStack Router, Tailwind v4 + daisyUI |
| server | API + DB | Hono, Drizzle ORM (beta.20), MySQL, zod |
| worker | 棋譜解析 | USI プロトコル, やねうら王 |

Hono RPC (`AppType` export + `hc<AppType>`) で server → web/worker 間の型を共有。shared パッケージは持たない。

## DB スキーマ

```
kifus
├── id: serial PK
├── title: varchar(255)
├── kifText: text              -- KIF 形式の棋譜テキスト
├── createdAt: timestamp
└── updatedAt: timestamp

moveAnalyses                   -- 1手ごとの解析レコード
├── id: serial PK
├── kifuId: FK → kifus.id (CASCADE)
├── moveNumber: int            -- 局面番号（1 = 初期局面）
├── movePlayed: varchar(255)?  -- 実際に指された手（USI 表記）
└── createdAt: timestamp

candidateMoves                 -- MultiPV の候補手
├── id: serial PK
├── moveAnalysisId: FK → moveAnalyses.id (CASCADE)
├── rank: int                  -- MultiPV 順位（1 = 最善）
├── move: varchar(255)         -- 候補手（USI 表記）
├── scoreType: varchar(16)     -- "cp"（centipawn）| "mate"
├── scoreValue: int
├── pv: json (string[])        -- 読み筋
└── depth: int                 -- 探索深さ
```

## API

### Web 向け（認証なし）

| Method | Path | 説明 |
|--------|------|------|
| GET | `/kifus` | 棋譜一覧（id, title, createdAt） |
| GET | `/kifus/:id` | 棋譜詳細 + 解析結果（moveAnalyses + candidateMoves） |
| POST | `/kifus` | 棋譜登録。body: `{ title, kifText }` → `{ id }` |
| DELETE | `/kifus/:id` | 棋譜削除（解析結果も CASCADE 削除） |

### Worker 向け（`Authorization: Bearer <API_KEY>` 必須）

| Method | Path | 説明 |
|--------|------|------|
| GET | `/worker/kifus` | 未解析の棋譜を取得 |
| POST | `/worker/analyses` | 解析結果を一括登録 |

Worker POST body:
```
{
  kifuId: number,
  analyses: [{
    moveNumber: number,
    movePlayed?: string,
    candidates: [{
      rank: number,
      move: string,          // USI 表記
      scoreType: "cp" | "mate",
      scoreValue: number,
      pv?: string[],
      depth: number
    }]
  }]
}
```

## Web 画面

| パス | 画面 | 内容 |
|------|------|------|
| `/` | 棋譜一覧 | テーブル表示。サーバー未接続時は警告を表示 |
| `/kifus/new` | 棋譜登録 | タイトル + KIF テキスト貼り付けフォーム |
| `/kifus/$id` | 棋譜詳細 | KIF テキスト表示 + 解析結果テーブル（MultiPV 対応） |

Vite dev server が `/api` プレフィックスを除去しつつ server にプロキシ。

## Worker

- `packages/worker/Dockerfile.engine` でやねうら王をソースビルド（マルチステージ）
- 本番 Docker イメージにはやねうら王バイナリ + Node.js worker プロセスが同居
- KIF テキストをパースし、各局面を USI プロトコルでやねうら王に送信
- MultiPV（デフォルト 3）で候補手を取得
- 解析結果を `POST /worker/analyses` でサーバーに送信
- ポーリング間隔: 設定可能（デフォルト 10秒）

### USI データ型

```
UsiScore = { type: "cp", value: number } | { type: "mate", value: number }

CandidateMove = {
  rank, move, score: UsiScore, pv: string[], depth
}

MoveAnalysis = {
  moveNumber, movePlayed?: string, candidates: CandidateMove[]
}

KifuAnalysisResult = {
  totalMoves, analyses: MoveAnalysis[], parseErrors: [{ line, text, reason }]
}
```

## 開発環境

`pnpm dev` (`docker compose watch`) で全サービス起動:

| サービス | ポート | 備考 |
|---------|--------|------|
| db | - | MySQL 8.4, tmpfs（データ揮発） |
| db-prep | - | drizzle-kit push でスキーマ反映後に終了 |
| server | 4000 | tsx watch, API_KEY=dev-api-key |
| web | 5173 | Vite dev server, API_URL=http://server:4000 |

ファイル変更は docker watch で自動同期。`pnpm-lock.yaml` 変更時はコンテナ再ビルド。

## 未実装

- 将棋盤 UI（盤面描画、指し手の可視化）
- Worker の本番デプロイ構成
- 評価値グラフ表示
