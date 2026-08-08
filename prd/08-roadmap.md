# 08. ロードマップ

各章の実装状況と計画を整理する。本 PRD は既存実装の記録から出発しているため、
「実装済み」を土台に、未実装・計画中を優先度付きで並べる。

---

## 実装済み（現状のループ）

- **投入**: KIF 貼り付け登録（メタ抽出・タイトル自動生成・変換ガード込み。[04](./04-ingestion.md)）。
  swars 一括取り込みは**実装を残置したまま無効化済み**（[04](./04-ingestion.md) §4）。
- **変換・メタ抽出**: CSA→KIF→USI 変換、対局者・勝敗・日時の抽出、対局タイトル生成（**両経路とも**。KIF 経路は成駒略記・終局マーカー対応 + `result` 導出。[01](./01-domain.md) / [04](./04-ingestion.md)）。
- **解析（worker）**: worker がやねうら王 + 評価関数で MultiPV 解析し、評価値・候補手読み筋を登録（[05](./05-analysis.md)）。
- **ポイズンピル対策**: `analysisError` で解析失敗をキューから除外、エンジン再起動、`reanalyze`（再変換＋世代照合）で復旧（[05](./05-analysis.md) §1.1a）。
- **悪手判定・可視化（Web）**: 悪手判定（評価値悪化 + 候補手外）は **Web 側で計算**（`packages/web/src/lib/usi.ts`）。
  棋譜詳細（盤面・評価値グラフ・候補手・日本語表記・悪手マーカー）、棋譜一覧（[05](./05-analysis.md)）。
- **LLM 下準備**: 解析結果を LLM 解説用 Markdown にエクスポート（[06](./06-llm-commentary.md)）。
- **認証**: cookie セッション（web）/ API_KEY（worker）（[07](./07-auth-and-privacy.md)）。

## 計画中

> swars 一括取り込みの定期化はかつて計画していたが、**取り込み自体を無効化した**ため取り下げた
> （実装は残置。[04](./04-ingestion.md) §4 / [decisions](./_grilling/decisions.md)）。

### 局面単位の再解析（優先度: 低）

- 特定局面だけ depth を変えて再解析する機能。
- Web の「この局面を深く解析」ボタン → worker に解析リクエスト（[05](./05-analysis.md)）。
- 再解析はその局面の候補手を**最新 1 世代に上書き**（depth 別世代は持たない。決定済み。[03](./03-data-model.md)）。

### KIF 貼り付けのタイトル編集・重複検知（gap）

- KIF 貼り付けのメタ抽出・変換堅牢化・ポイズンピル対策は**実装済み**（上記「実装済み」）。残る gap は
  登録後の**タイトル編集**（`PATCH /api/kifus/:id` は現状 `memo` のみ）と、KIF 貼り付けの**重複検知**（現状なし。手動削除で対応。[04](./04-ingestion.md) §8）。

### 戦型ラベル（優先度: 高・一部実装済み）

- 判定方式は**確定済み**（内部 / 一次 / 二次の 3 層 + 「駒がぶつかるまで」の観測窓。[01](./01-domain.md) §6）。
  スキーマも確定（`kifuTactics`。[03](./03-data-model.md) §2.1）。
- 段取りと現状: ✅ (1) 判定ロジックを `shared` へ純関数として置く（`packages/shared/src/tactics`）→
  ✅ (2) 投入時に判定して `kifuTactics` へ保存 + 一括再判定の口（`tactics:redetect`）→
  ✅ (2b) 一覧・詳細でのタグ表示（`TacticTags`）→ ✅ (3) 一覧のフィルタ軸
  （`tactic` / `tacticSide`。[09](./09-analytics.md) §7）→ **gap** (3b)「同じ戦型の過去局へ」の
  棋譜詳細からの導線 → **gap** (4) LLM プロンプトへ添える（[06](./06-llm-commentary.md) §3.2）。
- **`shared` 抽出を実利のある形で消化する機会**でもある（下記 gap と同時に進めるのが自然）。
- 発展: 局面ハッシュ（SFEN）による**局面横断検索**。「この局面が出た過去の自分の対局」を引ければ、
  定跡を外れた地点や、同じ形で毎回する失敗が自分の棋譜だけから見つかる。盤面追跡は既にあるので
  SFEN 出力を足せば土台は揃う（`shared` 抽出と同時にやるのが自然）。

### 分析ページ（戦型別成績。**実装済み**）

- 溜め込んだ棋譜を戦型で横断して数える画面（`/stats`）。設計は [09](./09-analytics.md) に確定済み。
  `kifuTactics` を別テーブルにした狙い（横断集計を JOIN 一本にする。[03](./03-data-model.md) §2.1）を
  初めて使う場所。
- 段取りと現状: ✅ (1) `shared` に絞り込みの語彙を公開（`NON_SIDE_ATTRIBUTED_LABELS` /
  `STORED_TACTIC_LABELS`。[09](./09-analytics.md) §6.1）+ 一覧の絞り込み拡張
  （`tactic` / `tacticSide` / `missedMate`）+ `candidate_moves` の索引（マイグレーション生成済み・
  本番未適用）→ ✅ (2) 集計エンドポイント `GET /api/stats/tactics`
  （`packages/server/src/stats-tactics-query.ts`。[09](./09-analytics.md) §6）→
  ✅ (3) `/stats` ページと一覧への導線（`packages/web/src/routes/stats.tsx` +
  `lib/statsTactics.ts`。[09](./09-analytics.md) §2.3・§2.4・§3・§5・§7）。
  **段取りは完了**で、残るのは [09](./09-analytics.md) §8 の将来の軸だけ。
- (1) を先に出したのは、分析ページが無くても単体で価値があるため（戦型ラベルの段取り (3) がこれにあたる）。

### `shared` 抽出・プロンプト生成のエンドポイント化（一部実装済み / 残りは gap）

- ✅ **`packages/shared` を新設し、`board.ts` を web から抽出済み**（テスト 19 件ごと移設）。
  盤面追跡に加え、盤面を必要とする USI→日本語表記（`usiToJapaneseWithPiece` / `getPieceName`）も含む。
  戦型判定を server から回すのに必要だったため先行して消化した。
- **まだ gap**: `lib/usi.ts`（盤面を使わない `usiToJapanese`・`toSenteEval`・`formatScore` 等）、
  `lib/cpl.ts`（悪手判定）、kifu-export、zod 検証スキーマ。いずれも `packages/web` にある。
- プロンプト生成を **server エンドポイント化**し、web の「コピー」ボタンもそれを使う（書式の単一真実）。
- 現状は web の `kifu-export` で自前生成しているため、これが理想との gap（[06](./06-llm-commentary.md) §2.3 / [02](./02-architecture.md) §3.2）。

### LLM 解説の自動生成（優先度: 検証中）

- **commentator = 軽量な監視スクリプト**（独立 container・worker 側）。server のプロンプト生成
  エンドポイントを fetch → LLM CLI → `commentaries` へ POST（薄く保つ）。
- Markdown フォーマット改善（戦型ラベル・SFEN 併記・Δ 列・注目局面の絞り込み）。
- 詳細は [06](./06-llm-commentary.md) §3。

### 評価値の精度向上

- 開発環境は MATERIAL（駒得ベース）のため序盤評価値が大きめに出る。本番 NNUE（評価関数同梱）で
  再解析すると安定する想定（[05](./05-analysis.md) §エンジン構成）。

## 確定事項（設計判断の記録）

- ✅ **API 型共有は Hono RPC / ドメイン実体は `shared`**: API 型は Hono RPC に集約、将棋ドメインの純ロジックと
  zod 検証スキーマは `shared` に置く（旧「shared を作らない」を改定。[02](./02-architecture.md) §3）。
- ✅ **解析来歴（engine/eval）は持たない** / **再解析は最新 1 世代に上書き**（[03](./03-data-model.md)）。
- ✅ **ポイズンピルは worker 側の失敗状態で受ける**（`analysisError`。投入時検証は best-effort。[05](./05-analysis.md) §1.1a）。
- ✅ **KIF→USI 変換は server 側で登録時に一度だけ**: worker は KIF パーサーを持たず `usiMoves` を消費（[04](./04-ingestion.md)）。
- ✅ **worker は解析用の別ホストに分離**: 評価関数のメモリ消費が大きく、VPS 同居は非現実的（[02](./02-architecture.md) §5）。
- ✅ **worker は単一インスタンス運用**: 解析結果はチャンクで追記されるため、同一棋譜を複数 worker が
  並行解析すると 1 棋譜に複数実行の値が混ざる。防ぐには poll 時の lease（列の追加）が要るが、
  **並行解析の需要が無いので運用前提で受ける**（[05](./05-analysis.md) §1.1c / [03](./03-data-model.md) §2）。
  複数 worker で解析を並列化したくなったら、lease の導入をそのとき設計する。
- ✅ **DB は MySQL 8.4**（開発経験）/ **Drizzle 1.0.0-beta.22**（1.0 追従目的）（[02](./02-architecture.md) §2）。
- ✅ **シングルユーザー**: owner 分離・マルチユーザー対応は持たない（[07](./07-auth-and-privacy.md)）。
- ✅ **戦型判定は 3 層 + 事象ベースの観測窓**: 内部 / 一次 / 二次ラベルに分け、観測窓は手数の定数ではなく
  「駒がぶつかるまで（その述語が見ている駒種は数えない）」で決める（[01](./01-domain.md) §6）。
- ✅ **一括取り込みの詳細は非公開**: 取得元・仕組み・アクセス方針は公開文書に書かず `.claude-personal/` に置く（[README](./README.md) §秘匿方針）。
- ✅ **戦型別集計は生ラベルで数える**: `suppressForDisplay` は表示専用で集計に掛けない。一覧の
  `EXISTS(label = ?)` と定義が一致し、件数の食い違いが原理的に起きない（[09](./09-analytics.md) §2.1 /
  [decisions](./_grilling/decisions.md)）。
- ✅ **取りこぼしの判定に悪手判定を使わない**: 「実手が詰みでない」の確認は「その局を負けた」に含まれるため、
  素の SQL 述語で書ける（[09](./09-analytics.md) §3.1）。

## 恒常課題

- **解析エンジンの二重性**: 開発 MATERIAL と本番 NNUE で評価値が変わる。**来歴は DB に持たず**、本番 NNUE
  単一運用で受ける（決定。[03](./03-data-model.md)）。異常値は目視で気づける前提。同じ棋譜でもエンジンで
  数値が変わることは UI・LLM 解説の双方が前提として持つ（[05](./05-analysis.md) / [06](./06-llm-commentary.md)）。
- ~~**一括取り込みの持続性**~~: swars 一括取り込みを無効化したため課題としては停止（実装は残置。§投入 / [04](./04-ingestion.md) §4）。
