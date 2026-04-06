# Seseragi（細流棋）棋譜解析システム仕様書

スペックの余っているデスクトップ PC で棋譜解析を行う個人開発システム。
TypeScript フルスタック、pnpm monorepo 構成。

## システム構成

```
                    ┌─────────┐
                    │ 将棋    │
                    │ ウォーズ │
                    └────┬────┘
                         │ [未実装] 棋譜自動取得
┌─────────┐     ┌───────▼─┐     ┌─────────┐
│   web   │────▶│ server  │◀────│ worker  │
│ React   │proxy│ Hono    │API  │ Node.js │
│ Vite    │/api │ Drizzle │KEY  │ USI     │
└─────────┘     └────┬────┘     └────┬────┘
                     │               │
                ┌────▼────┐     ┌────▼────┐
                │  MySQL  │     │yaneuraou│
                └─────────┘     │+水匠5  │
                                │+ペタブック│
                                └─────────┘
```

### デプロイ構成

| 環境 | サービス | 備考 |
|------|---------|------|
| VPS (1GB) | web + server + db | グローバルにアクセス可能 |
| デスクトップ PC (32GB) | worker | API_KEY で server に接続。CPU 解析 |

VPS は web アクセス用、デスクトップ PC は解析用に分離。VPS での worker 動作も検討したが、メモリ消費量的に厳しく デスクトップ一択。

### パッケージ

| パッケージ | 役割 | 主要技術 |
|-----------|------|---------|
| web | 棋譜管理 UI | React 19, Vite 8, TanStack Router, Tailwind v4 + daisyUI, clsx |
| server | API + DB | Hono, Drizzle ORM (beta.20), MySQL, zod |
| worker | 棋譜解析 | USI プロトコル, やねうら王 |

- MySQL: 開発経験が多いため選択
- Drizzle ORM beta.20: 1.0 正式リリースが近く、早めにキャッチアップする目的

Hono RPC (`AppType` export + `hc<AppType>`) で server → web/worker 間の型を共有。shared パッケージは持たない。
Drizzle ORM の型情報を Hono RPC 経由でフロントエンドまで伝えられるのが利点。

## DB スキーマ

```
kifus
├── id: serial PK
├── title: varchar(255)
├── kifText: text              -- KIF 形式の棋譜テキスト
├── swarsGameKey: varchar(255) UNIQUE -- 将棋ウォーズ対局キー（重複検知用、nullable）
├── createdAt: timestamp
└── updatedAt: timestamp

moveAnalyses                   -- 1手ごとの解析レコード
├── id: serial PK
├── kifuId: FK → kifus.id (CASCADE)
├── moveNumber: int            -- 局面番号（0 = 初期局面）
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

### Web 向け（[未実装] 認証方式検討中）

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
| POST | `/swars/import` | 将棋ウォーズ棋譜取得。body: `{ userId, gtype?, pages? }` |

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
| `/` | 棋譜一覧 | テーブル表示。解析済み/未バッジ表示。サーバー未接続時は警告を表示 |
| `/kifus/new` | 棋譜登録 | タイトル + KIF テキスト貼り付けフォーム |
| `/kifus/$id` | 棋譜詳細 | 将棋盤 + 評価値 + 解析結果 |

### 棋譜詳細画面の機能

- **将棋盤**: 9x9 テキスト盤面。先手=黒字、後手=赤字+180度反転。スライダーで局面移動
- **持ち駒表示**: 先手・後手それぞれ
- **局面評価値**: 先手視点のスコア + 形勢判断ラベル（互角/有利/優勢/勝勢/詰み）
- **候補手一覧**: 各候補に読み筋・探索深さ・実手マーク・最善手との差異を表示
- **日本語表記**: USI→駒名付き日本語変換（▲７六歩(77)）。盤面追跡で駒名を解決
- **評価値グラフ**: SVG 直書きの折れ線グラフ。先手有利=上、後手有利=下。スライダーと連動、クリックで局面移動
- **KIF テキスト**: 折りたたみ表示
- **候補手詳細**: 折りたたみ表示

Vite dev server が `/api` プレフィックスを除去しつつ server にプロキシ。

## Worker

### エンジン構成

| | 開発用 (Dockerfile) | 本番用 (Dockerfile.prod) |
|---|---|---|
| EDITION | MATERIAL（駒得、開発環境の低スペックに合わせた軽量版） | NNUE |
| 評価関数 | なし | 水匠5 (nn.bin, ~60MB) |
| 定跡 | なし | ペタブック (new_petabook233) |
| TARGET_CPU | OTHER | OTHER（本番デスクトップも同様） |

### エンジンオプション

| オプション | 環境変数 | デフォルト | 説明 |
|-----------|---------|-----------|------|
| Threads | ENGINE_THREADS | 1 | |
| USI_Hash | ENGINE_HASH | 128 (MB) | 本番では 2048-4096 推奨 |
| MultiPV | ENGINE_MULTIPV | 3 | 候補手数 |
| — | ENGINE_DEPTH | 10 | 探索深さ |
| — | ENGINE_BYOYOMI | 未設定 | 秒読み(ms)。設定時は depth より優先。エンジンが局面の複雑さに応じて深さを自動調整 |
| EvalDir | ENGINE_EVAL_DIR | — | 本番: /usr/local/share/yaneuraou/eval |
| BookDir | ENGINE_BOOK_DIR | — | 本番: /usr/local/share/yaneuraou/book |
| BookFile | — | user_book1.db | BookDir 設定時に自動設定 |
| IgnoreBookPly | — | true | 定跡の手数制限を無視 |
| FlippedBook | — | true | 180度回転局面も定跡としてヒット |
| BookOnTheFly | — | true | 定跡を逐次読み（メモリ節約） |
| BookMoves | — | 999 | 定跡採用の手数制限なし |
| BookEvalDiff | — | 0 | 最善手のみ採用 |
| BookDepthLimit | — | 0 | 末端の指し手も採用 |

### 解析フロー

1. サーバーから未解析の棋譜を取得（`GET /worker/kifus`）
2. KIF テキストをパース → USI 形式の手列に変換
3. 各局面を MultiPV（デフォルト 3）で解析。定跡ヒット時はスキップ
4. 解析結果をサーバーに送信（`POST /worker/analyses`）
5. ポーリング間隔（デフォルト 10秒）で繰り返し

### 解析 depth 目安

| depth | 用途 | 時間/局面(1CPU) |
|-------|------|---------------|
| 10-12 | 簡易解析 | 数秒 |
| 15-18 | 標準解析 | 数十秒 |
| 20+ | 詳細解析 | 数分 |

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
| db | - | MySQL 8.4, tmpfs（データ揮発、高速化 + テストデータが小規模のため） |
| db-prep | - | drizzle-kit push + sample.kif シード |
| server | 4000 | tsx watch, API_KEY=dev-api-key |
| web | 5173 | Vite dev server, API_URL=http://server:4000 |
| worker | - | tsx watch, Material エンジン（開発用）, cpus: 1 |

ファイル変更は docker watch で自動同期。`pnpm-lock.yaml` 変更時はコンテナ再ビルド。

## 未実装・計画中

### 認証 (優先度: 高)
- Web 向けルートに認証が必要（グローバル公開のため）
- 候補: 本番 nginx の Basic 認証が最有力（個人用のため）、Hono 側での実装、Cloudflare Access 等
- ユーザーは自分一人なのでマルチユーザー対応は不要

### 将棋ウォーズ棋譜取得 (実装済み・ポーリング未実装)

`POST /swars/import` で手動トリガー。詳細は `docs/swars-cookie-test.md` を参照。

**実装済み:**
- 履歴ページから対局キー抽出 → 個別棋譜取得 → CSA→KIF 変換 → DB 保存
- `swarsGameKey` カラムによる重複検知
- 3 秒間隔のレート制限付きフェッチャー
- `apiKeyRequired` で保護

**未実装:**
- 定期ポーリング（1 時間に 1 回の自動取得）
- Cookie 失効時の通知・再取得フロー

**認証:**
- `_web_session` Cookie（Rails CookieStore、有効期限約 20 年）
- 手動ブラウザログインで取得（Cloudflare Turnstile のため自動ログイン不可）
- 環境変数 `SWARS_SESSION_COOKIE` で管理

**アクセス制御方針:**
- リクエスト間隔: 3 秒以上
- User-Agent: ブラウザ同等の値を設定
- 非公式アクセスのためアカウント BAN リスクあり（控えめに運用）

### 局面単位の再解析 (優先度: 低)
- 特定局面だけ depth を変えて再解析する機能
- Web UI から「この局面を深く解析」ボタン → worker に解析リクエスト

