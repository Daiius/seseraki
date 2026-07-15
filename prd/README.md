# PRD: Seseraki（細流棋）

> **基準は「あるべき設計の理想形」**。動いている実装は入力の一つとして扱い、理想と異なる箇所は
> 理想を本文に書いた上で**現状との gap** として管理する。未確定の論点は各章で「要確認」と明記する。
> 仕様策定の決定ログは [`_grilling/decisions.md`](./_grilling/decisions.md)。

## 目的

将棋の棋譜を取り込み、エンジンで解析し、疑問手・分岐・評価値推移を閲覧できる**個人用**の棋譜解析サービス。
スペックの余っているデスクトップ PC を解析エンジンのホストとして活用する。主眼は次の 3 つ:

1. **棋譜を溜め込んで自動で解析する** — 対局履歴からの一括取り込みと KIF 貼り付けで棋譜を登録し、
   対局相手・勝敗・対局日時といった基本メタを起こしてタイトルを自動生成する。あとは放っておけば解析が回る。
2. **エンジン解析で疑問手・分岐を可視化する** — やねうら王 + 評価関数で各局面を MultiPV 解析し、
   評価値推移・悪手判定・候補手の読み筋を Web 上で並べて眺められるようにする。
3. **LLM 解説の下準備をする** — 棋譜と解析結果を整形した Markdown を生成し、LLM に貼ると質の高い
   講評が返ることを活かす。将来はこの生成を自動化する（[06](./06-llm-commentary.md)）。

将棋ソフトとの相互運用も意識し、直接連携まではしないものの **KIF 形式の読み取り**（貼り付け）に対応する。

## スコープ

- **実装済み**: 履歴からの一括取り込み（対局メタ抽出・タイトル自動生成込み）/ KIF 貼り付け登録（現状は指し手のみ・
  メタ抽出は gap。[04](./04-ingestion.md) §3）/ KIF→USI 変換 /
  worker によるエンジン解析（MultiPV・評価値・悪手判定）/ 棋譜詳細 UI（盤面・評価値グラフ・候補手・
  日本語表記）/ LLM 解説用 Markdown エクスポート / cookie セッション認証。
- **計画中**: 一括取り込みの定期化 / 局面単位の再解析 / LLM 解説の自動生成（commentator）。詳細は [08-roadmap.md](./08-roadmap.md)。

## アーキ概観

- フルスタック TypeScript の pnpm monorepo: 現在は `packages/{web,server,worker}`（理想構成で `shared` を追加、
  将来 `commentator`。[02](./02-architecture.md) §3 / [08](./08-roadmap.md)）。
- MySQL 8.4 / Hono(RPC) / Drizzle 1.0 RC / React 19 + Vite + TanStack Router + Tailwind v4 + daisyUI。
- worker（Node.js + USI + やねうら王）は server とは分離した実行環境で稼働し、API_KEY で server を polling する。
- 設計の柱: **API 型共有は Hono RPC に集約**しつつ、**将棋ドメインの純ロジックと zod 検証スキーマは `shared`**
  に置いて web/server（将来 commentator）で共有する（[02](./02-architecture.md) §3）。

```
        [ 履歴からの一括取り込み / KIF 貼り付け / CSA 直接貼り付け ]
                          │  すべて server 側で USI へ変換し kifus に収束
                          ▼
   web (UI) ──fetch /api──> server (Hono) ──> MySQL
                              ▲   │  API_KEY polling（未解析棋譜取得 / 解析結果登録）
                              │   ▼
                       worker（分離実行環境）── USI ── やねうら王 + 評価関数
```

## 公開リポジトリでの秘匿方針

本リポジトリは**公開**であるため、PRD にも以下を持ち込まない（[07](./07-auth-and-privacy.md) §公開配置の前提）:

- 秘密情報（`.env*`・API_KEY・DB 資格情報・session cookie の値）。
- 本番/開発の具体情報（ドメイン・TLS・接続先・リバースプロキシ構成）。PRD は**姿勢のみ**記述する。
- 履歴からの一括取り込みの取得元・仕組み・アクセス方針。実装/運用の詳細は公開文書に書かず、
  gitignore 対象の **`.claude-personal/`** に置き、「存在すれば参照」する。

## 文書索引

1. [01-domain.md](./01-domain.md) — 将棋棋譜ドメインとプロダクト動機（KIF/USI・対局メタ・解析の意味）
2. [02-architecture.md](./02-architecture.md) — 技術スタック / monorepo / 型共有 / 開発環境 / デプロイ姿勢
3. [03-data-model.md](./03-data-model.md) — DB スキーマ（kifus / moveAnalyses / candidateMoves）
4. [04-ingestion.md](./04-ingestion.md) — 投入ルート / KIF→USI 変換 / メタ抽出 / 一括取り込み
5. [05-analysis.md](./05-analysis.md) — worker エンジン解析 / Web 可視化（盤面・評価値・候補手・悪手判定）
6. [06-llm-commentary.md](./06-llm-commentary.md) — LLM 解説用エクスポートと自動生成構想
7. [07-auth-and-privacy.md](./07-auth-and-privacy.md) — 認証 / API_KEY / 公開配置
8. [08-roadmap.md](./08-roadmap.md) — フェーズ分け / 未実装・計画中 / 確定事項
