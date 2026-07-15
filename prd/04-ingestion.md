# 04. 投入（ingestion）

本章は「棋譜をどうアプリに入れるか」を定める。データ構造は [03](./03-data-model.md)、ドメインは [01](./01-domain.md) を参照。

---

## 1. 設計思想

- **すべての投入ルートは `kifus` に収束する。** 入口が swars 一括取り込みでも KIF 貼り付けでも、server 側で
  **KIF→USI 変換**を通してから保存する（[01](./01-domain.md) §2）。**対局メタ抽出は現状 swars 経路のみ**で、
  KIF 貼り付けは gap（§3）。
- worker は変換済み `usiMoves` だけを消費し、KIF パーサーを持たない（[02](./02-architecture.md) / [05](./05-analysis.md)）。

## 2. 投入ルート一覧

| ルート | 対象 | 変換 | フェーズ |
|---|---|---|---|
| **swars 一括取り込み** | swars の対局履歴 | CSA→KIF→USI（server） | 実装済み（手動トリガー） |
| **KIF 貼り付け** | 他ソフトのエクスポート等 | KIF→USI（server） | 実装済み |
| **CSA 直接貼り付け** | 他ソフトの CSA 出力 | CSA→KIF→USI（server） | 計画中（既存の CSA→KIF 変換器を再利用） |

> **対象外**: KIF ファイルアップロード / SFEN（SFEN は単一局面で棋譜解析のスコープ外。[01](./01-domain.md) §6）。

## 3. KIF 貼り付け登録

- Web の棋譜登録画面（`/kifus/new`）でタイトル + KIF テキストを貼り付け → `POST /kifus`。
- server は KIF をパースして次を行う（`packages/server/src/kif`）:
  1. **USI へ変換**して `usiMoves` を作る。
  2. **（理想）対局メタを抽出**（sente/gote/senteDan/goteDan/result/playedAt。[03](./03-data-model.md)）。
  3. `kifText`（原本）とタイトルとともに `kifus` に保存し、`{ id }` を返す。
- 登録直後は未解析（`analysisCompletedAt = null`）。worker が拾って解析する（[05](./05-analysis.md)）。

> ⚠️ **現状の gap**: KIF 貼り付け経路（`POST /kifus`）は現在 **`title`（ユーザー入力）+ `kifText` + `usiMoves` のみ保存**し、
> 対局メタ抽出（上記 2）とタイトル自動生成は**未実装**。対局メタ抽出・タイトル自動生成は**一括取り込み経路で実装済み**
> （[decisions](./_grilling/decisions.md)）。KIF から棋譜メタを起こすパーサ拡張が理想との gap（[08](./08-roadmap.md)）。

> **対局タイトルの自動生成**（理想）: 抽出した「対戦相手・勝敗」からタイトルを起こす（[01](./01-domain.md) §1）。
> タイトルは**登録時に決まる**（swars 一括取り込みは自動生成、KIF 貼り付けはユーザー入力）。
> 登録後のタイトル編集は現状未実装（`PATCH /kifus/:id` は `memo` のみ。理想では編集可。gap）。

- **CSA 直接貼り付け**（計画中）も同じ窓口に載せる。CSA→KIF は既存の変換器を再利用し、以降は KIF 経路と共通。
  変換器は一括取り込み専用ではないため、server 内の中立な場所に置く（取り込み専用ディレクトリに縛らない）。

## 4. swars 一括取り込み（半自動）

- swars の対局履歴からまとめて棋譜を取り込むルート。**Web の「更新」ボタン**から手動トリガーし、**非同期ジョブ**で走る。
- エンドポイント: `POST /swars/import`（202 即応答・バックグラウンド実行。body `{ userId, gtype?, pages? }`）→
  `GET /swars/import/status`（`idle` / `running` / `done` / `error`）。いずれも `sessionRequired` で保護（[07](./07-auth-and-privacy.md)）。
- 取り込んだ棋譜は **CSA→KIF 変換**を経て、以降は §3 と同じ KIF→USI 変換 + 対局メタ抽出 + 保存の下流に載る。
- 重複は `swarsGameKey`（UNIQUE）で検知し、既取得はスキップする（[03](./03-data-model.md)）。
- エラーは `errorKind: 'cookie_expired' | 'generic'` に分類。Web は SWR で status を 3 秒間隔ポーリングし `done`/`error` で停止。

> ⚠️ **swars の正式名称・取得の詳細な仕組み（履歴/CSA の取得方法）・アクセス姿勢・資格情報は公開文書に書かない。**
> `.claude-personal/`（gitignore 対象）の運用メモに集約する（[README](./README.md) §公開リポジトリでの秘匿方針）。

## 5. レビュー・検証

- 現状、投入は**確認ステップなしで保存**する（個人用・入力元が信頼できるため）。
- 重複は `swarsGameKey`（UNIQUE）で自動排除。KIF 貼り付けの重複検知は持たない（手動削除で対応）。
- **整合チェック（best-effort）**: KIF→USI 変換の結果を投入時に軽く検証する（`applyMove` が破綻しないか等。
  検証スキーマは `shared`。[02](./02-architecture.md) §3.2）。ただし**完全な合法性検証は将棋ルール一式が要り容易でない**ため
  保証はせず、取りこぼしは worker 側の失敗状態で受ける（ポイズンピル対策。[05](./05-analysis.md) §1.1a / [03](./03-data-model.md)）。

## 6. worker 向け API（解析結果の投入）

worker からの投入は `Authorization: Bearer <API_KEY>` 必須の別系統（[07](./07-auth-and-privacy.md)）。

| Method | Path | 説明 |
|---|---|---|
| GET | `/worker/kifus` | 未解析かつ失敗なし（`analysisCompletedAt IS NULL AND analysisError IS NULL`）の最古を 1 件取得（なければ null）。`usiMoves` を含む |
| POST | `/worker/analyses` | 解析結果をトランザクションで登録（既存データは DELETE → 再投入で冪等） |
| POST | `/worker/kifus/:id/error` | 解析失敗を報告し `analysisError` を記録（ポイズンピル対策。[05](./05-analysis.md) §1.1a） |

`POST /worker/analyses` の body:

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

## 7. 未確認・将来の論点

- **一括取り込みの定期化**（1 時間に 1 回程度の自動化。現状は手動トリガーのみ。[08](./08-roadmap.md)）。
- **CSA 直接貼り付け**の実装（決定済み・計画中。§2）。KIF ファイルアップロード / SFEN は**対象外**（決定）。
- KIF 貼り付けの重複検知（現状なし）。
