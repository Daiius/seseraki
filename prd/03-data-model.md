# 03. データモデル

本章は DB スキーマ（Drizzle + MySQL 8.4）と、worker が扱う USI データ型を定める。
ドメイン用語は [01](./01-domain.md)、投入時の変換・抽出は [04](./04-ingestion.md)、解析での消費は [05](./05-analysis.md) を参照。

> 本章は**理想スキーマ**を定め、**PRD が正典**（[README](./README.md) 時制方針）。現行実装の型・制約は
> Drizzle（`packages/server/src/db`）を参照し、PRD との差（例: `analysisError` / `commentaries` は現行未実装の gap）は
> 各所で「計画中」「gap」と明示する。カラム名・enum は本章を正とする。
> スキーマ変更は `pnpm db:migrate`（`drizzle-kit push --force`）で反映する（[02](./02-architecture.md)）。

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
├── swarsGameKey: varchar(255) UNIQUE?  -- 一括取り込み由来の対局一意キー（重複検知用・nullable）
├── playedAt: timestamp?         -- 対局日時
├── analysisCompletedAt: timestamp?     -- 解析完了日時（INDEX）
├── analysisError: text?                -- 解析失敗理由（worker がエンジン失敗時に記録。ポイズンピル対策）
├── memo: text?                         -- ユーザー自由記述メモ（PATCH /kifus/:id で編集）
├── createdAt: timestamp
└── updatedAt: timestamp
```

- **`kifText` は原本**（KIF）。`usiMoves` は登録時に変換した派生物で、解析前でも盤面表示に使える（[05](./05-analysis.md)）。
- **`swarsGameKey`** は一括取り込み由来棋譜の一意キー。UNIQUE 制約で**重複取得を検知**する（[04](./04-ingestion.md)）。
  KIF 貼り付け等では null。
- **`analysisCompletedAt`** に INDEX。worker は「**未解析（`analysisCompletedAt IS NULL`）かつ失敗なし
  （`analysisError IS NULL`）の最古**」を引く（[05](./05-analysis.md)）。
- **`analysisError`**: worker がエンジンの異常終了/illegal move を検知したときに理由を記録する。これにより
  poll から除外され、**解析できない棋譜がキューを詰まらせない**（ポイズンピル対策。[05](./05-analysis.md)）。
  再試行は error をクリアする（手動 or 再解析アクション）。
- 対局メタ（sente/gote/dan/result/playedAt）は**一括取り込み経路では登録時に抽出**して埋める。
  **KIF 貼り付け経路のメタ抽出は未実装（gap）**（[04](./04-ingestion.md) §3 / [08](./08-roadmap.md)）。取れなければ null。
- **`memo`** はユーザーの自由記述。棋譜詳細で編集し（`PATCH /kifus/:id`）、一覧は有無（`hasMemo`）のみ返す（[05](./05-analysis.md)）。

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
- `UNIQUE(kifuId, moveNumber)` で同一局面の二重登録を防ぐ。再解析は DELETE → 再投入（[04](./04-ingestion.md)）。

## 4. `candidateMoves`（MultiPV の候補手）

```
candidateMoves
├── id: serial PK
├── moveAnalysisId: FK → moveAnalyses.id (CASCADE)
├── rank: int                    -- MultiPV 順位（1 = 最善）
├── move: varchar(255)           -- 候補手（USI 表記）
├── scoreType: varchar(16)       -- "cp"（centipawn） | "mate"
├── scoreValue: int
├── pv: json (string[])          -- 読み筋
├── depth: int                   -- 探索深さ
└── UNIQUE(moveAnalysisId, rank)
```

- 1 局面につき MultiPV 本数（既定 3）の行が入る。`rank=1` が最善手。
- `scoreType` / `scoreValue` は **USI エンジンが返した手番視点のスコアをそのまま格納**する（正規化しない）。
  先手視点への変換は表示・判定時に moveNumber の parity で行う（後手番＝奇数は符号反転。[01](./01-domain.md) §5 / [05](./05-analysis.md)）。
- `pv` は読み筋（USI 指し手列）。Web の分岐再生・悪手判定に使う（[05](./05-analysis.md)）。

## 5. worker が扱う USI データ型

worker → server の解析結果登録（[04](./04-ingestion.md) §worker API）で用いる形。DB の 3 テーブルに 1:1 対応する。

```
UsiScore = { type: "cp", value: number } | { type: "mate", value: number }

CandidateMove = { rank, move, score: UsiScore, pv: string[], depth }

MoveAnalysis  = { moveNumber, candidates: CandidateMove[] }

KifuAnalysisResult = { totalMoves, analyses: MoveAnalysis[] }
```

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

- LLM 解説を DB 保存する場合の `commentaries` テーブル追加（[06](./06-llm-commentary.md) / [08](./08-roadmap.md)）。

### 決定済み

- ✅ **解析エンジン・評価関数の来歴は持たない**（2026-07-16）。本番は NNUE 単一運用で、開発 MATERIAL の
  数値は一時的な確認用。異常な評価値は目視で気づけるため、エンジンの自己申告を仕込むのは過剰設計と判断。
  保持するのは `candidateMoves.depth`（候補手単位）のみ。
- ✅ **局面単位の再解析は最新 1 世代に上書き**（depth 別の複数世代は持たない。単一エンジン前提。[05](./05-analysis.md) / [08](./08-roadmap.md)）。
