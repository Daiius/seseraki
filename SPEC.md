# Shogi 棋譜解析システム仕様書

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

### パッケージ

| パッケージ | 役割 | 主要技術 |
|-----------|------|---------|
| web | 棋譜管理 UI | React 19, Vite 8, TanStack Router, Tailwind v4 + daisyUI, clsx |
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
| `/kifus/$id` | 棋譜詳細 | 将棋盤 + 評価値 + 解析結果 |

### 棋譜詳細画面の機能

- **将棋盤**: 9x9 テキスト盤面。先手=黒字、後手=赤字+180度反転。スライダーで局面移動
- **持ち駒表示**: 先手・後手それぞれ
- **局面評価値**: 先手視点のスコア + 形勢判断ラベル（互角/有利/優勢/勝勢/詰み）
- **最善手比較**: 実際の手と最善手が異なる場合、候補手と読み筋を表示
- **日本語表記**: USI→駒名付き日本語変換（▲７六歩(77)）。盤面追跡で駒名を解決
- **KIF テキスト**: 折りたたみ表示
- **候補手詳細**: 折りたたみ表示

Vite dev server が `/api` プレフィックスを除去しつつ server にプロキシ。

## Worker

### エンジン構成

| | 開発用 (Dockerfile) | 本番用 (Dockerfile.prod) |
|---|---|---|
| EDITION | MATERIAL（駒得） | NNUE |
| 評価関数 | なし | 水匠5 (nn.bin, ~60MB) |
| 定跡 | なし | ペタブック (new_petabook233) |
| TARGET_CPU | OTHER | AVX2 |

### 本番エンジンオプション

| オプション | 値 | 説明 |
|-----------|-----|------|
| EvalDir | /usr/local/share/yaneuraou/eval | 水匠5 評価関数 |
| BookDir | /usr/local/share/yaneuraou/book | ペタブック定跡 |
| IgnoreBookPly | true | 定跡の手数制限を無視 |
| FlippedBook | true | 180度回転局面も定跡としてヒット |
| BookOnTheFly | true | 定跡を逐次読み（メモリ節約） |
| BookMoves | 999 | 定跡採用の手数制限なし |
| BookEvalDiff | 0 | 最善手のみ採用 |
| BookDepthLimit | 0 | 末端の指し手も採用 |
| Threads | 環境変数 ENGINE_THREADS | |
| USI_Hash | [未実装] 環境変数で設定予定 | |

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
| db | - | MySQL 8.4, tmpfs（データ揮発） |
| db-prep | - | drizzle-kit push + sample.kif シード |
| server | 4000 | tsx watch, API_KEY=dev-api-key |
| web | 5173 | Vite dev server, API_URL=http://server:4000 |
| worker | - | tsx watch, Material エンジン（開発用） |

ファイル変更は docker watch で自動同期。`pnpm-lock.yaml` 変更時はコンテナ再ビルド。

## 未実装・計画中

### 認証 (優先度: 高)
- Web 向けルートに認証が必要（グローバル公開のため）
- 候補: Hono で静的ファイル配信 + Basic 認証、nginx Basic 認証、Cloudflare Access 等
- ユーザーは自分一人なのでマルチユーザー対応は不要

### 将棋ウォーズ棋譜自動取得 (優先度: 中)

調査完了、実装待ち。詳細は `docs/swars-cookie-test.md` を参照。

**取得フロー:**
1. 履歴一覧取得（Cookie 必須）: `GET /games/history?user_id=Daiius&page={n}` → HTML から対局キーを抽出
2. 個別棋譜取得（認証不要）: `GET /games/{対局キー}` → `data-react-props` 内の JSON を取得
3. JSON 内の CSA 形式の手列 + SFEN 初期局面から KIF に変換して DB 登録

**棋譜データ形式:**
- CSA 風の独自形式（`+7776FU,L600`）+ 残り時間付き
- SFEN 初期局面つきで USI 互換
- メタデータ: 先手/後手名、段級位、結果、ルール（10分/3分/10秒）、手合い

**認証:**
- `_web_session` Cookie（Rails CookieStore、有効期限約20年）
- 手動ブラウザログインで取得（Cloudflare Turnstile のため自動ログイン不可）
- 環境変数 `SWARS_SESSION_COOKIE` で管理
- Cookie 有効期間は別セッションでテスト中

**アクセス制御方針:**
- リクエスト間隔: 3秒以上
- ポーリング頻度: 1時間に1回（新規対局の差分のみ）
- User-Agent: ブラウザ同等の値を設定
- 非公式アクセスのためアカウント BAN リスクあり（控えめに運用）

### 評価値グラフ (優先度: 中)
- 棋譜詳細画面に評価値の推移グラフを表示
- 先手視点で +/- のグラフ。悪手の箇所が一目でわかるように

### 局面単位の再解析 (優先度: 低)
- 特定局面だけ depth を変えて再解析する機能
- Web UI から「この局面を深く解析」ボタン → worker に解析リクエスト

### USI_Hash 設定 (優先度: 低)
- 環境変数 `ENGINE_HASH` でハッシュテーブルサイズを設定
- デスクトップ PC (32GB) では 2048-4096MB を想定
