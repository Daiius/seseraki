# 細流棋（seseraki） - 自動棋譜取得 & 解析

棋譜解析を行う Web アプリ。

自動で棋譜を取得し解析にかけ、結果を web で確認する流れを「せせらぎ」に見立て、

その古い読み方・表記である「せせらき」と棋譜解析機能を表した名前を付けました。

## システム構成

### フロントエンド

```mermaid
sequenceDiagram
    participant U as User
    participant W as web<br/>React + Vite
    participant S as server<br/>Hono + Drizzle
    participant DB as MySQL
    participant WK as 棋譜解析

    U->>W: 棋譜を閲覧・登録
    W->>S: /api/* (proxy)
    S->>DB: 読み書き

    U->>W: 棋譜詳細を表示
    W->>S: GET /kifus/:id
    S-->>W: 棋譜 + 解析結果
    W-->>U: 将棋盤<br>評価値グラフ<br>候補手

    WK->>S: 解析結果を送信
    S->>DB: 保存
```

### 棋譜解析

```mermaid
sequenceDiagram
    participant W as フロントエンド
    participant S as server<br/>Hono + Drizzle
    participant DB as MySQL
    participant WK as worker<br/>Node.js
    participant E as yaneuraou<br/>+ 水匠5 + 定跡

    loop ポーリング
        WK->>S: GET /worker/kifus (API_KEY)
        S-->>WK: 未解析の棋譜
        WK->>E: USI 通信で解析
        E-->>WK: 評価値<br>候補手<br>読み筋
        WK->>S: POST /worker/analyses
        S->>DB: 解析結果を保存
    end

    S-->>W: 棋譜 + 解析結果
```

## 技術スタック

| パッケージ | 役割        | 主要技術                                                |
| ---------- | ----------- | ------------------------------------------------------- |
| web        | 棋譜管理 UI | React 19, Vite, TanStack Router, Tailwind CSS + daisyUI |
| server     | API + DB    | Hono, Drizzle ORM, MySQL, zod                           |
| worker     | 棋譜解析    | USI プロトコル, やねうら王                              |

## 開発

```bash
pnpm dev    # docker compose watch で全サービス起動
```

- web: http://localhost:5173
- server: http://localhost:4000

## そもそも

解析エンジンを載せるサーバーはある程度のスペックが必要です。

インフラ管理費が必要な分、既存の解析サービスを使ったり、将棋エンジン開発者をサポートした方が得られるリターンは大きいかも...?

## 利用ソフトウェア

- [やねうら王](https://github.com/yaneurao/YaneuraOu) (GPL-3.0) — 将棋エンジン
- [水匠5](https://github.com/yaneurao/YaneuraOu/releases/tag/suisho5) — NNUE 評価関数
- [ペタブック定跡](https://github.com/yaneurao/YaneuraOu/releases/tag/new_petabook233) (MIT) — 定跡データベース
