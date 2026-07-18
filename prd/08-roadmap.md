# 08. ロードマップ

各章の実装状況と計画を整理する。本 PRD は既存実装の記録から出発しているため、
「実装済み」を土台に、未実装・計画中を優先度付きで並べる。

---

## 実装済み（現状のループ）

- **投入**: 履歴からの一括取り込み（手動トリガー・非同期ジョブ）/ KIF 貼り付け登録（メタ抽出・タイトル自動生成・変換ガード込み。[04](./04-ingestion.md)）。
- **変換・メタ抽出**: CSA→KIF→USI 変換、対局者・勝敗・日時の抽出、対局タイトル生成（**両経路とも**。KIF 経路は成駒略記・終局マーカー対応 + `result` 導出。[01](./01-domain.md) / [04](./04-ingestion.md)）。
- **解析（worker）**: worker がやねうら王 + 評価関数で MultiPV 解析し、評価値・候補手読み筋を登録（[05](./05-analysis.md)）。
- **ポイズンピル対策**: `analysisError` で解析失敗をキューから除外、エンジン再起動、`reanalyze`（再変換＋世代照合）で復旧（[05](./05-analysis.md) §1.1a）。
- **悪手判定・可視化（Web）**: 悪手判定（評価値悪化 + 候補手外）は **Web 側で計算**（`packages/web/src/lib/usi.ts`）。
  棋譜詳細（盤面・評価値グラフ・候補手・日本語表記・悪手マーカー）、棋譜一覧（[05](./05-analysis.md)）。
- **LLM 下準備**: 解析結果を LLM 解説用 Markdown にエクスポート（[06](./06-llm-commentary.md)）。
- **認証**: cookie セッション（web）/ API_KEY（worker）（[07](./07-auth-and-privacy.md)）。

## 計画中

### swars 一括取り込みの定期化（優先度: 中）

- 現状は手動トリガーのみ。定期実行を追加する。
- **取り込み頻度・アクセス運用（アクセス姿勢）は公開文書に書かず** `.claude-personal/` の運用メモに置く（[README](./README.md) §秘匿方針）。

### 局面単位の再解析（優先度: 低）

- 特定局面だけ depth を変えて再解析する機能。
- Web の「この局面を深く解析」ボタン → worker に解析リクエスト（[05](./05-analysis.md)）。
- 再解析はその局面の候補手を**最新 1 世代に上書き**（depth 別世代は持たない。決定済み。[03](./03-data-model.md)）。

### KIF 貼り付けのタイトル編集・重複検知（gap）

- KIF 貼り付けのメタ抽出・変換堅牢化・ポイズンピル対策は**実装済み**（上記「実装済み」）。残る gap は
  登録後の**タイトル編集**（`PATCH /api/kifus/:id` は現状 `memo` のみ）と、KIF 貼り付けの**重複検知**（現状なし。手動削除で対応。[04](./04-ingestion.md) §8）。

### `shared` 抽出・プロンプト生成のエンドポイント化（gap）

- board/usi/kifu-export を web から **`shared`** へ抽出（web/server で共有）。
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
- ✅ **DB は MySQL 8.4**（開発経験）/ **Drizzle 1.0.0-beta.22**（1.0 追従目的）（[02](./02-architecture.md) §2）。
- ✅ **シングルユーザー**: owner 分離・マルチユーザー対応は持たない（[07](./07-auth-and-privacy.md)）。
- ✅ **一括取り込みの詳細は非公開**: 取得元・仕組み・アクセス方針は公開文書に書かず `.claude-personal/` に置く（[README](./README.md) §秘匿方針）。

## 恒常課題

- **解析エンジンの二重性**: 開発 MATERIAL と本番 NNUE で評価値が変わる。**来歴は DB に持たず**、本番 NNUE
  単一運用で受ける（決定。[03](./03-data-model.md)）。異常値は目視で気づける前提。同じ棋譜でもエンジンで
  数値が変わることは UI・LLM 解説の双方が前提として持つ（[05](./05-analysis.md) / [06](./06-llm-commentary.md)）。
- **一括取り込みの持続性**: 取得に必要な資格情報の手動更新とレート制限運用（詳細は `.claude-personal/`）。
