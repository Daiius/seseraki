# Seseraki（細流棋）棋譜解析システム仕様書

スペックの余っているデスクトップ PC で棋譜解析を行う個人開発システム。
TypeScript フルスタック、pnpm monorepo 構成。

## システム構成

```
                    ┌─────────┐
                    │  swars  │
                    │         │
                    └────┬────┘
                         │ 棋譜取得（手動トリガー）
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
| VPS (1GB) | web + server + db | nginx の Basic 認証下で公開 |
| デスクトップ PC (32GB) | worker | API_KEY で server に接続。CPU 解析 |

VPS は web アクセス用、デスクトップ PC は解析用に分離。VPS での worker 動作も検討したが、メモリ消費量的に厳しく デスクトップ一択。

本番イメージ:
- `ghcr.io/daiius/seseraki-server`: server を esbuild バンドル → distroless で実行
- worker: `packages/worker/Dockerfile.prod` で本番デスクトップ上でビルド。やねうら王 NNUE + 水匠5 + ペタブック定跡を同梱、esbuild バンドルで実行

### パッケージ

| パッケージ | 役割 | 主要技術 |
|-----------|------|---------|
| web | 棋譜管理 UI | React 19, Vite 8, TanStack Router, Tailwind v4 + daisyUI, clsx |
| server | API + DB + KIF パース | Hono, Drizzle ORM (beta.20), MySQL, zod |
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
├── kifText: text              -- KIF 形式の棋譜テキスト（原本保管用）
├── usiMoves: json (string[])? -- USI 形式の指し手列（棋譜登録時に KIF から変換）
├── sente: varchar(100)?       -- 先手プレイヤー名
├── gote: varchar(100)?        -- 後手プレイヤー名
├── senteDan: smallint?        -- 先手段位
├── goteDan: smallint?         -- 後手段位
├── result: varchar(50)?       -- 対局結果
├── swarsGameKey: varchar(255) UNIQUE -- swars対局キー（重複検知用、nullable）
├── playedAt: timestamp?       -- 対局日時
├── analysisCompletedAt: timestamp? -- 解析完了日時（INDEX）
├── createdAt: timestamp
└── updatedAt: timestamp

moveAnalyses                   -- 1手ごとの解析レコード
├── id: serial PK
├── kifuId: FK → kifus.id (CASCADE)
├── moveNumber: int            -- 局面番号（0 = 初期局面）
├── createdAt: timestamp
└── UNIQUE(kifuId, moveNumber)

candidateMoves                 -- MultiPV の候補手
├── id: serial PK
├── moveAnalysisId: FK → moveAnalyses.id (CASCADE)
├── rank: int                  -- MultiPV 順位（1 = 最善）
├── move: varchar(255)         -- 候補手（USI 表記）
├── scoreType: varchar(16)     -- "cp"（centipawn）| "mate"
├── scoreValue: int
├── pv: json (string[])        -- 読み筋
├── depth: int                 -- 探索深さ
└── UNIQUE(moveAnalysisId, rank)
```

## API

### Web 向け（[未実装] 認証方式検討中）

| Method | Path | 説明 |
|--------|------|------|
| GET | `/kifus` | 棋譜一覧（ページネーション付き、対局日時新しい順） |
| GET | `/kifus/:id` | 棋譜詳細 + 解析結果（moveAnalyses + candidateMoves） |
| POST | `/kifus` | 棋譜登録。body: `{ title, kifText }` → `{ id }` |
| DELETE | `/kifus/:id` | 棋譜削除（解析結果も CASCADE 削除） |

全リクエストに `hono/logger` でアクセスログを出力。`CORS_ORIGINS` 環境変数（カンマ区切り）で CORS 許可オリジンを設定可能。

### Worker 向け（`Authorization: Bearer <API_KEY>` 必須）

| Method | Path | 説明 |
|--------|------|------|
| GET | `/worker/kifus` | 未解析の最古の棋譜を1件取得（なければ null）。usiMoves を含む |
| POST | `/worker/analyses` | 解析結果をトランザクションで登録（既存データは DELETE → 再投入） |

### swars 棋譜取得（`Authorization: Bearer <CLIENT_API_KEY>` 必須）

| Method | Path | 説明 |
|--------|------|------|
| POST | `/swars/import` | swars棋譜取得。body: `{ userId, gtype?, pages? }` |

Worker POST body:
```
{
  kifuId: number,
  analyses: [{
    moveNumber: number,
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
| `/` | 棋譜一覧 | テーブル表示。解析済み/未バッジ、勝敗バッジ（VITE_SWARS_USER_ID 設定時）表示。swars 棋譜取得「更新」ボタン。サーバー未接続時は警告を表示 |
| `/kifus/new` | 棋譜登録 | タイトル + KIF テキスト貼り付けフォーム |
| `/kifus/$id` | 棋譜詳細 | 将棋盤 + 評価値 + 解析結果 |

### 棋譜詳細画面の機能

- **将棋盤**: 9x9 テキスト盤面（size-10）。先手=黒字、後手=赤字+180度反転。スライダーで局面移動。直前の指し手の移動先マスをハイライト表示（bg-primary/15）。解析前でも usiMoves があれば盤面表示可能。盤面反転ボタン付き（後手ユーザーの場合はデフォルト反転）
- **持ち駒表示**: 先手・後手それぞれ。プレイヤー名を左、持ち駒を右に配置
- **局面評価値**: 実手後の局面の先手視点スコア + 形勢判断ラベル（互角/有利/優勢/勝勢/詰み）
- **候補手一覧**: 各候補に読み筋・探索深さ・実手マーク・最善手との差異を表示。初期3件表示、4件以上は chevron で折り畳み
- **悪手判定**: 局面評価値が手番側にとって 300cp 以上悪化し、かつ実手が候補手リスト外の場合に悪手と判定。悪手=赤い▲/△（手番対応）、非悪手の非最善手=※（warning 色）
- **日本語表記**: USI→駒名付き日本語変換（▲７六歩(77)）。盤面追跡で駒名を解決
- **評価値グラフ**: SVG 直書きの折れ線グラフ。先手有利=上、後手有利=下。スライダーと連動、クリックで局面移動。悪手マーカー表示（先手▲/後手▽、相手の悪手は透明度を下げる）
- **レイアウト**: 盤面と候補手は `md` ブレークポイントで横並び/縦並みを切り替え。KIF テキスト・局面評価値テーブル・候補手詳細はページ下部に折り畳み（デフォルト閉じ）

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

1. サーバーから未解析の最古の棋譜を1件取得（`GET /worker/kifus`、`usiMoves` を含む）
2. `usiMoves` を使って各局面を MultiPV（デフォルト 3）で解析。定跡ヒット時はエンジンが即座に候補手を返す
3. 解析結果をサーバーにトランザクションで送信（`POST /worker/analyses`）
4. ポーリング間隔（デフォルト 10秒）で繰り返し。idle 時はログ出力なし

KIF→USI 変換は server 側で棋譜登録時に実行される。worker は KIF パーサーを持たない。

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
  moveNumber, candidates: CandidateMove[]
}

KifuAnalysisResult = {
  totalMoves, analyses: MoveAnalysis[]
}
```

## 開発環境

`pnpm dev` (`docker compose watch`) で全サービス起動:

| サービス | ポート | 備考 |
|---------|--------|------|
| db | 3306 | MySQL 8.4, named volume で永続 |
| server | 4000 | `.env.database` + `.env.server` |
| web | 5173 | Vite dev server, `.env.web` |
| worker | - | Material エンジン（開発用）, cpus: 1, `.env.worker` |

ファイル変更は docker watch の `sync+restart` で自動同期・再起動。`pnpm-lock.yaml` 変更時はコンテナ再ビルド。
スキーマ変更時は `pnpm db:migrate`、初回データ投入は `pnpm db:seed` を手動実行。

## 未実装・計画中

### 認証

- 本番 nginx で Basic 認証を設定（個人用のため）
- API_KEY（worker 用）と CLIENT_API_KEY（Web フロントエンド用）の二種類を運用中
- CLIENT_API_KEY は Basic 認証の裏にあるので機密性は低い扱い、漏洩時は差し替え
- ユーザーは自分一人なのでマルチユーザー対応は不要

### swars棋譜取得 (実装済み・ポーリング未実装)

`POST /swars/import` で手動トリガー。

**実装済み:**
- 履歴ページから対局キー抽出 → 個別棋譜取得 → CSA→KIF 変換 → DB 保存
- `swarsGameKey` カラムによる重複検知
- 3 秒間隔のレート制限付きフェッチャー
- `clientApiKeyRequired` で保護（CLIENT_API_KEY）
- Web UI の「更新」ボタンからもトリガー可能

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

