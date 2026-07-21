# 04. 投入（ingestion）

本章は「棋譜をどうアプリに入れるか」を定める。データ構造は [03](./03-data-model.md)、ドメインは [01](./01-domain.md) を参照。

---

## 1. 設計思想

- **すべての投入ルートは `kifus` に収束する。** 入口が swars 一括取り込みでも KIF 貼り付けでも、server 側で
  **KIF→USI 変換 + 対局メタ抽出**を通してから保存する（[01](./01-domain.md) §2）。**メタ抽出は両経路とも実装済み**（§3）。
- worker は変換済み `usiMoves` だけを消費し、KIF パーサーを持たない（[02](./02-architecture.md) / [05](./05-analysis.md)）。

## 2. 投入ルート一覧

| ルート | 対象 | 変換 | フェーズ |
|---|---|---|---|
| **swars 一括取り込み** | swars の対局履歴 | CSA→KIF→USI（server） | 実装済み（手動トリガー） |
| **KIF 貼り付け** | 他ソフトのエクスポート等 | KIF→USI（server） | 実装済み |
| **CSA 直接貼り付け** | 他ソフトの CSA 出力 | CSA→KIF→USI（server） | 計画中（既存の CSA→KIF 変換器を再利用） |

> **対象外**: KIF ファイルアップロード / SFEN（SFEN は単一局面で棋譜解析のスコープ外。[01](./01-domain.md) §6）。

## 3. KIF 貼り付け登録

- Web の棋譜登録画面（`/kifus/new`）でタイトル（任意）+ KIF テキストを貼り付け → `POST /api/kifus`。
- server は KIF をパースして次を行う（`packages/server/src/kif`）:
  1. **USI へ変換**して `usiMoves` を作る。**パースエラーがある / 手合割が平手でない**場合は変換不能として
     `usiMoves = null` で保存する（§5）。
  2. **対局メタを抽出**（sente/gote/senteDan/goteDan/result/playedAt/sourceTz）。ヘッダ行（`先手：`/`後手：`/`開始日時：`/
     段位表記）から起こす。**result は終局マーカー（`詰み`/`投了`/`切れ負け`/`千日手`/`持将棋` 等）＋ 手番 parity から
     swars 互換コード（`{SENTE_WIN|GOTE_WIN|DRAW}_{理由}`）を導出**し、既存の勝敗バッジ・LLM エクスポートと揃える
     （[03](./03-data-model.md) / [01](./01-domain.md) §6）。`中断` 等の勝敗なしは null。
     **開始日時のタイムゾーン**: KIF にはタイムゾーン欄が無い。将棋アプリによって `開始日時` を JST で書くもの・UTC で
     書くものがあり、UTC を JST 決め打ちで読むと 9h ずれて他アプリの棋譜と混ざったとき並びが崩れる。そこで
     **投入時に TZ を明示指定**できるようにする（`POST /api/kifus` の `sourceTz`: `auto`（既定）/`JST`/`UTC`）。
     `auto` は KIF の署名から推定（既定 JST。UTC で書き出すアプリの固有指紋＝「先頭行が柿木形式コメント ＋ `持ち時間：`
     ＋ `終了日時`/`場所` を持たない」に一致したものだけ UTC）。署名は一意な肯定指紋を作りにくいため**あくまで初期値の
     提案**で、確定はユーザーの選択に委ねる。決定した TZ を `sourceTz` に残し、`playedAt` は解釈 TZ の絶対時刻で保存する。
     **reanalyze は保存済み `sourceTz` を維持**する（再パースで TZ を取り違えない）。swars 経路は `gameKey` 由来で常に JST。
  3. `kifText`（原本）とタイトルとともに `kifus` に保存し、`{ id }` を返す。
- 登録直後は未解析（`analysisCompletedAt = null`）。`usiMoves` があれば worker が拾って解析する（[05](./05-analysis.md)）。

> **タイトル**: `title` は任意入力。空なら抽出したメタから `${sente} vs ${gote}` を自動生成する
> （対局者不明時は日付/「無題」）。swars 一括取り込みと同じく自動生成に寄せ、都度命名の摩擦をなくす
> （旧「KIF 貼り付けはユーザー入力」を改定。[decisions](./_grilling/decisions.md)）。
> 登録後のタイトル編集は現状未実装（`PATCH /api/kifus/:id` は `memo` のみ。理想では編集可。gap。[08](./08-roadmap.md)）。

> ✅ **実装済み**: KIF 貼り付け経路（`POST /api/kifus`）も上記 2 のメタ抽出（sente/gote/段位/日時 + `result` 導出）・
> タイトル自動生成、および §5 の変換ガード（パースエラー/非平手手合割 → `usiMoves = null`）を備える。
> 残る gap は登録後のタイトル編集（`PATCH /api/kifus/:id` は `memo` のみ）と KIF 貼り付けの重複検知（§8）。

- **CSA 直接貼り付け**（計画中）も同じ窓口に載せる。CSA→KIF は既存の変換器を再利用し、以降は KIF 経路と共通。
  変換器は一括取り込み専用ではないため、server 内の中立な場所に置く（取り込み専用ディレクトリに縛らない）。

## 4. swars 一括取り込み（半自動）

- swars の対局履歴からまとめて棋譜を取り込むルート。**Web の「更新」ボタン**から手動トリガーし、**非同期ジョブ**で走る。
- **遡るページ数は Web から指定する**（ボタン隣のセレクト・1〜10・既定 1）。常用は最新 1 ページだが、初回セットアップや
  久しぶりの取り込みでは過去分を遡る必要があるため。選択は永続化せず、リロードで既定に戻す（[decisions](./_grilling/decisions.md)）。
- エンドポイント: `POST /api/swars/import`（202 即応答・バックグラウンド実行。body `{ userId, gtype?, pages? }`）→
  `GET /api/swars/import/status`（`idle` / `running` / `done` / `error`）。いずれも `sessionRequired` で保護（[07](./07-auth-and-privacy.md)）。
- 取り込んだ棋譜は **CSA→KIF 変換**を経て、以降は §3 と同じ KIF→USI 変換 + 対局メタ抽出 + 保存の下流に載る。
- 重複は `swarsGameKey`（UNIQUE）で検知し、既取得はスキップする（[03](./03-data-model.md)）。
- エラーは `errorKind: 'cookie_expired' | 'generic'` に分類。Web は SWR で status を 3 秒間隔ポーリングし `done`/`error` で停止。

> ⚠️ **swars の正式名称・取得の詳細な仕組み（履歴/CSA の取得方法）・アクセス姿勢・資格情報は公開文書に書かない。**
> `.claude-personal/`（gitignore 対象）の運用メモに集約する（[README](./README.md) §公開リポジトリでの秘匿方針）。

## 5. レビュー・検証

- 現状、投入は**確認ステップなしで保存**する（個人用・入力元が信頼できるため）。
- 重複は `swarsGameKey`（UNIQUE）で自動排除。KIF 貼り付けの重複検知は持たない（手動削除で対応）。
- **整合チェック（best-effort）**: KIF→USI 変換の結果を投入時に検証する。当面は **パースエラー（指し手行の変換失敗）
  または手合割が平手でない棋譜を「変換不能」とみなし `usiMoves = null` で保存**する（記録＝`kifText`・メタは残るが解析対象外。
  `GET /api/worker/kifus` の `usiMoves IS NOT NULL` 条件で自動的に除外される）。**壊れた部分的な `usiMoves` を worker に渡さない**のが
  要点で、1 手でも欠落すると手番がズレ、構文上は妥当な USI 列のまま盤面が破綻して illegal move を招く。
  完全な合法性検証（`applyMove` による盤面追跡・打ち歩詰め等）は将棋ルール一式が要り容易でなく、盤面ロジック・検証スキーマを
  `shared` に置く理想は残すが（[02](./02-architecture.md) §3.2）、当面は上記の軽量ガード＋ worker 側の失敗状態で取りこぼしを受ける
  （ポイズンピル対策。[05](./05-analysis.md) §1.1a / [03](./03-data-model.md)）。

## 6. Web 向け API（セッション認証）

Web UI が使うエンドポイント（`sessionRequired`。認証エンドポイントは [07](./07-auth-and-privacy.md)）:

| Method | Path | 説明 |
|---|---|---|
| GET | `/api/kifus` | 棋譜一覧（既定は `coalesce(playedAt, createdAt)` 降順・50件ページネーション。`hasMemo` を返す）。検索・絞り込み・並べ替えのクエリは下表 |
| GET | `/api/kifus/:id` | 棋譜詳細 + 解析結果（moveAnalyses + candidateMoves） |
| POST | `/api/kifus` | KIF 貼り付け登録。body `{ title?, kifText }` → `{ id }`（title 省略時は自動生成。§3） |
| PATCH | `/api/kifus/:id` | メモ更新。body `{ memo }`（現状 `memo` のみ。タイトル編集は gap。§3） |
| POST | `/api/kifus/:id/reanalyze` | `kifText` を再パースし `usiMoves`＋メタ列を再生成、**旧 `moveAnalyses` を削除**し `analysisError`/`analysisCompletedAt` をクリア、**`analysisRevision` を +1** して再キュー（`title`/`memo` は温存）。トランザクション実行。パーサ修正後の既存棋譜の復旧と失敗棋譜の再試行を兼ねる（[05](./05-analysis.md) §1.1a / [03](./03-data-model.md)） |
| DELETE | `/api/kifus/:id` | 棋譜削除（解析結果も CASCADE） |
| POST | `/api/swars/import` | swars 取り込みジョブ起動（202・非同期。§4） |
| GET | `/api/swars/import/status` | swars 取り込みジョブ状態（§4） |

### 6.1 `GET /api/kifus` のクエリ

組み立ては `packages/server/src/kifu-list-query.ts`（DB 接続を持たない純関数。route から使い、単体テストを持つ）。
未指定は既定値で、条件は AND で結合する。件数（`pagination.total`）も同じ条件で数える。

| パラメータ | 値 | 既定 | 説明 |
|---|---|---|---|
| `page` | 1〜 | `1` | 50件ページネーション |
| `q` | 文字列（100字まで） | なし | `title` / `sente` / `gote` の部分一致。LIKE のワイルドカードはエスケープして素の部分一致にする。上限超過は 400（web も同じ上限を持つ。[05](./05-analysis.md) §2.5） |
| `status` | `all` \| `analyzed` \| `unanalyzed` \| `failed` | `all` | 一覧のバッジと同じ区分（`failed` は `analysisError`、他は `analysisError IS NULL` かつ `analysisCompletedAt` の有無） |
| `outcome` | `all` \| `win` \| `loss` | `all` | 自分から見た勝敗。`self` と組で使う |
| `self` | 自分の名前候補（カンマ区切り） | なし | 「自分」は web の `VITE_SELF_NAMES` ∪ `VITE_SWARS_USER_ID` が単一の正なので、server は設定を持たず**判定材料を web から受け取る**。両対局者とも候補に一致する対局は側を確定できないため除外する（web の `resolveUserSide` が ambiguous とするのと同じ扱い）。候補が空なら勝敗の絞り込みは 0 件 |
| `from` / `to` | `YYYY-MM-DD` | なし | `coalesce(playedAt, createdAt)` に対する期間。**両端を含む**（`to` は翌日 0 時未満）。境界は DB セッションのタイムゾーンで解釈 |
| `sort` | `playedAt` \| `createdAt` \| `title` | `playedAt` | `playedAt` は `coalesce(playedAt, createdAt)`（一覧の日時列と同じ基準値。[05](./05-analysis.md) §2.5） |
| `order` | `asc` \| `desc` | `desc` | 同値が並んでもページ間で行が重複・欠落しないよう `id` を副キーに添える |

## 7. worker 向け API（解析結果の投入）

worker からの投入は `Authorization: Bearer <API_KEY>` 必須の別系統（[07](./07-auth-and-privacy.md)）。

| Method | Path | 説明 |
|---|---|---|
| GET | `/api/worker/kifus` | 未解析かつ失敗なし（`analysisCompletedAt IS NULL AND analysisError IS NULL`）の最古を 1 件取得（なければ null）。`usiMoves` と `analysisRevision` を含む |
| POST | `/api/worker/analyses` | 解析結果をトランザクションで登録（既存データは DELETE → 再投入で冪等）。`revision` が現在の `analysisRevision` と一致するときだけ適用（`{ applied }` を返す。[03](./03-data-model.md)） |
| POST | `/api/worker/kifus/:id/error` | 解析失敗を報告し `analysisError` を記録。`revision` 一致時のみ適用（ポイズンピル対策・世代照合。[05](./05-analysis.md) §1.1a） |

`POST /api/worker/analyses` の body（`revision` は `GET /api/worker/kifus` で得た取得時の解析世代）:

```
{
  kifuId: number,
  revision: number,
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

## 8. 未確認・将来の論点

- **swars 一括取り込みの定期化**（現状は手動トリガーのみ。頻度・アクセス運用は `.claude-personal/`。[08](./08-roadmap.md)）。
- **CSA 直接貼り付け**の実装（決定済み・計画中。§2）。KIF ファイルアップロード / SFEN は**対象外**（決定）。
- KIF 貼り付けの重複検知（現状なし）。
