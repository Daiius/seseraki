# 03. データモデル

本章は DB スキーマ（Drizzle + MySQL 8.4）と、worker が扱う USI データ型を定める。
ドメイン用語は [01](./01-domain.md)、投入時の変換・抽出は [04](./04-ingestion.md)、解析での消費は [05](./05-analysis.md) を参照。

> 本章は**理想スキーマ**を定め、**PRD が正典**（[README](./README.md) 時制方針）。現行実装の型・制約は
> Drizzle（`packages/server/src/db`）を参照し、PRD との差（例: `commentaries` は現行未実装の gap）は
> 各所で「計画中」「gap」と明示する。カラム名・enum は本章を正とする。
> スキーマ変更は dev では `pnpm db:push`（強制同期）、本番では `pnpm db:generate` → `pnpm db:migrate`（バージョン管理マイグレーション）で反映する（[02](./02-architecture.md) §6）。

---

## 1. テーブル概要

| テーブル | 役割 |
|---|---|
| `kifus` | 棋譜の原本・変換済み指し手・対局メタ・解析状態 |
| `moveAnalyses` | 1 局面ごとの解析レコード（`kifus` に紐付く） |
| `candidateMoves` | MultiPV の候補手（`moveAnalyses` に紐付く） |
| `commentaries`（計画中） | LLM 解説（`kifus` と 1:1。[06](./06-llm-commentary.md)） |

- リレーション: `kifus 1 — N moveAnalyses 1 — N candidateMoves`。いずれも FK は **CASCADE 削除**。
- **単一ユーザー前提**のため owner 分離は持たない（[07](./07-auth-and-privacy.md)）。
- 投入・API 境界の **runtime 検証は zod で行い、検証スキーマは `shared` に置く**（型共有だけでは動作時に
  不正データを弾けないため。[02](./02-architecture.md) §3.2 / [04](./04-ingestion.md)）。

## 2. `kifus`（棋譜）

```
kifus
├── id: serial PK
├── title: varchar(255)          -- 対局タイトル（メタから自動生成 / 手入力）
├── kifText: text                -- KIF 形式の棋譜テキスト（原本保管用）
├── usiMoves: json (string[])?   -- USI 形式の指し手列（登録時に KIF から変換）
├── sente: varchar(100)?         -- 先手プレイヤー名
├── gote: varchar(100)?          -- 後手プレイヤー名
├── senteDan: smallint?          -- 先手段位
├── goteDan: smallint?           -- 後手段位
├── result: varchar(50)?         -- 対局結果
├── swarsGameKey: varchar(255) UNIQUE?  -- swars 対局キー（重複検知用・nullable）
├── playedAt: timestamp?         -- 対局日時（sourceTz で解釈した絶対時刻）
├── sourceTz: varchar(8)?        -- playedAt の解釈 TZ（"JST" 既定 / "UTC"。署名判定。[04](./04-ingestion.md)）
├── analysisCompletedAt: timestamp?     -- 解析完了日時（INDEX）
├── analysisError: text?                -- 解析失敗理由（worker がエンジン失敗時に記録。ポイズンピル対策）
├── analysisRevision: int notNull default 0 -- 解析世代（reanalyze で +1。worker 報告の世代照合用）
├── memo: text?                         -- ユーザー自由記述メモ（PATCH /api/kifus/:id で編集）
├── createdAt: timestamp
└── updatedAt: timestamp
```

- **`kifText` は原本**（KIF）。`usiMoves` は登録時に変換した派生物で、解析前でも盤面表示に使える（[05](./05-analysis.md)）。
- **`swarsGameKey`** は swars 由来棋譜の一意キー。UNIQUE 制約で**重複取得を検知**する（[04](./04-ingestion.md)）。
  KIF 貼り付け等では null。
- **`sourceTz`**: `開始日時` にタイムゾーン欄が無い KIF を正しく並べるため、`playedAt` を解釈した TZ を記録する。
  投入時にユーザーが選択（`auto`/`JST`/`UTC`。`auto` は署名から推定＝既定 JST）。UTC のときは +9h 補正した絶対時刻を保存。
  swars 経路は `gameKey` 由来で常に `"JST"`。reanalyze はこの値を維持する（[04](./04-ingestion.md)）。
- **`analysisCompletedAt`** に INDEX。worker は「**未解析（`analysisCompletedAt IS NULL`）かつ失敗なし
  （`analysisError IS NULL`）の最古**」を引く（[05](./05-analysis.md)）。
- **`analysisError`**: worker がエンジンの異常終了/illegal move/timeout を検知したときに理由を記録する。これにより
  poll から除外され、**解析できない棋譜がキューを詰まらせない**（ポイズンピル対策。[05](./05-analysis.md) §1.1a）。
  再試行は `POST /api/kifus/:id/reanalyze`（`kifText` を再変換して `usiMoves`・メタを作り直し error をクリア。[04](./04-ingestion.md) §6）。
  **`analysisCompletedAt` と `analysisError` は排他**（同時に非 null にならない）: error は未完了時のみ記録し、
  完了 submit は error なし時のみ適用する（行ロック下で相互排他。重複取得/複数 worker でも矛盾状態を作らない）。
- **`analysisRevision`**: 解析世代。`reanalyze` で +1 する。`GET /api/worker/kifus` は現在の revision を返し、worker は
  `POST /api/worker/analyses` / `POST /api/worker/kifus/:id/error` に取得時 revision を添える。server は **同一 revision のときだけ**
  結果/失敗を適用する。これにより、reanalyze で状態をリセットした後に**実行中だった旧解析の報告が新状態を上書きするのを防ぐ**
  （旧成功で completed 復活・旧失敗で error 復活を弾く。[05](./05-analysis.md) §1.1a）。
- 対局メタ（sente/gote/dan/result/playedAt）は**一括取り込み・KIF 貼り付けの両経路とも登録時に抽出**して埋める
  （KIF 経路は `result` を終局マーカー＋手番 parity から導出。[04](./04-ingestion.md) §3）。取れなければ null。
- **`memo`** はユーザーの自由記述。棋譜詳細で編集し（`PATCH /api/kifus/:id`）、一覧は有無（`hasMemo`）のみ返す（[05](./05-analysis.md)）。

## 3. `moveAnalyses`（局面ごとの解析）

```
moveAnalyses
├── id: serial PK
├── kifuId: FK → kifus.id (CASCADE)
├── moveNumber: int              -- 局面番号（0 = 初期局面）
├── createdAt: timestamp
└── UNIQUE(kifuId, moveNumber)
```

- 1 局面 = 1 レコード。`moveNumber = N` は **N 手適用後・N+1 手目を指す前の局面**（0 は初期局面）。
  偶数 = 先手番 / 奇数 = 後手番（[01](./01-domain.md) §5）。
- 解析結果は**チャンクに分けて追記**される（[05](./05-analysis.md) §1.1c）。**一意性と完了の担保は
  次の 3 箇所に分散する**（submit が「DELETE → 全件 INSERT」だった頃は 1 箇所だった。列の追加はない）:

| 担保するもの | 担保する場所 |
|---|---|
| 同一 `moveNumber` の重複防止 | `UNIQUE(kifuId, moveNumber)` を使った upsert（再送された局面は既存行を使い回し、`candidateMoves` を入れ直す） |
| 前世代の全消去 | **`reanalyze` の DELETE が唯一の経路**（`POST /api/kifus/:id/reanalyze`。submit 側は DELETE しない） |
| 完了の確定 | 件数が `usiMoves.length + 1` に達したときの `analysisCompletedAt`（submit と同一トランザクション内で server が判定） |

- ⚠ **`reanalyze` の DELETE を落とすと前世代の行が残る**（手数の異なる棋譜に差し替わったときに、
  古い末尾の局面が孤立して残り、件数による完了判定も狂う）。
- 途中まで入っている件数は再開位置でもある（`GET /api/worker/kifus` の `analyzedCount`。
  [05](./05-analysis.md) §1.1c / [04](./04-ingestion.md) §7）。

## 4. `candidateMoves`（MultiPV の候補手）

```
candidateMoves
├── id: serial PK
├── moveAnalysisId: FK → moveAnalyses.id (CASCADE)
├── rank: int                    -- MultiPV 順位（1 = 最善）
├── move: varchar(255)           -- 候補手（USI 表記）
├── scoreType: varchar(16)       -- "cp"（centipawn） | "mate"
├── scoreValue: int
├── pv: json (string[])?         -- 読み筋（nullable）
├── depth: int                   -- 探索深さ
└── UNIQUE(moveAnalysisId, rank)
```

- 1 局面につき MultiPV 本数（既定 3）の行が入る。`rank=1` が最善手。
- `scoreType` / `scoreValue` は **USI エンジンが返した手番視点のスコアをそのまま格納**する（正規化しない）。
  先手視点への変換は表示・判定時に moveNumber の parity で行う（後手番＝奇数は符号反転。[01](./01-domain.md) §5 / [05](./05-analysis.md)）。
- `pv` は読み筋（USI 指し手列）。利用先は**読み筋を人に見せる 3 箇所**（[05](./05-analysis.md) §2.2 /
  [06](./06-llm-commentary.md)）:
  1. 盤面直下の候補手一覧での読み筋表示（日本語表記に変換して並べる）
  2. 分岐再生（読み筋を 1 手ずつ盤面に進める）
  3. LLM 解説用テキストの注目局面の読み筋
- **悪手判定は `pv` を参照しない**（`rank` / `move` / `scoreType` / `scoreValue` だけで決まる。
  [05](./05-analysis.md) §2.3）。

## 5. worker が扱う USI データ型

worker → server の解析結果登録（[04](./04-ingestion.md) §worker API）で用いる形。DB の 3 テーブルに 1:1 対応する。

```
UsiScore = { type: "cp", value: number } | { type: "mate", value: number }

CandidateMove = { rank, move, score: UsiScore, pv: string[], depth }

MoveAnalysis  = { moveNumber, candidates: CandidateMove[] }
```

- **submit の単位は `MoveAnalysis[]`（チャンク）**。worker は棋譜 1 局分を貯めず、経過時間で区切って
  送る（[05](./05-analysis.md) §1.1c）。解析を終えたときに worker が持つのはサマリ
  （`KifuAnalysisSummary = { totalMoves, analyzed }`）だけで、局面ごとの結果は送信済み。

## 6. `commentaries`（LLM 解説・計画中）

LLM 解説（[06](./06-llm-commentary.md)）で使う。**`kifus` と 1:1**、再生成は**上書き**。**生成キューを兼ねる**。

```
commentaries
├── kifuId: FK → kifus.id (PK, CASCADE)  -- 1:1
├── status: enum(queued, done, failed)   -- 生成キューの状態
├── body: text?                 -- 解説本文（Markdown。完了まで null）
├── llmModel: varchar?          -- 生成に使ったモデル（来歴・任意）
├── promptVersion: varchar?     -- プロンプト書式のバージョン（任意）
├── error: text?                -- 生成失敗理由（failed 用）
├── createdAt: timestamp
└── updatedAt: timestamp
```

- **手動トリガー方式**（[06](./06-llm-commentary.md) §3）: Web の「解説生成」ボタンで `status=queued` の行を作る/戻す
  → commentator が `queued` を polling して生成 → `done`。**別途キュー/ジョブテーブルは持たない**（薄い watcher 思想）。
- 生成失敗は `status=failed` + `error` で受け、無限リトライを防ぐ（ポイズンピルと同じ思想。§2）。
- Web の「解説あり」表示は `status=done` で判定。解説の世代管理はしない（1 棋譜 1 解説・上書き。§7）。

## 7. 未確認・将来の論点

（データモデルの主要論点は下記「決定済み」で解決。`commentaries` は §6 で確定・計画中。）

### 決定済み

- ✅ **解析エンジン・評価関数の来歴は持たない**（2026-07-16）。本番は NNUE 単一運用で、開発 MATERIAL の
  数値は一時的な確認用。異常な評価値は目視で気づけるため、エンジンの自己申告を仕込むのは過剰設計と判断。
  保持するのは `candidateMoves.depth`（候補手単位）のみ。
- ✅ **局面単位の再解析は最新 1 世代に上書き**（depth 別の複数世代は持たない。単一エンジン前提。[05](./05-analysis.md) / [08](./08-roadmap.md)）。
