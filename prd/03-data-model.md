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
| `kifuTactics`（計画中） | 戦型ラベル（`kifus` に紐付く派生値。[01](./01-domain.md) §6） |
| `commentaries`（計画中） | LLM 解説（`kifus` と 1:1。[06](./06-llm-commentary.md)） |
| `videoKifuSources` | 動画解析の由来メタ（`kifus` と 1:1。[10](./10-video-analysis.md) §3.1） |
| `kifuPositions` | 局面索引（`kifus` に紐付く派生値。[10](./10-video-analysis.md) §3.2） |

- リレーション: `kifus 1 — N moveAnalyses 1 — N candidateMoves`、`kifus 1 — N kifuTactics`。
  いずれも FK は **CASCADE 削除**。
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
├── senteDan: smallint?          -- 先手段級（段=正 1〜9 / 級=負 -1〜-30。[01](./01-domain.md) §3）
├── goteDan: smallint?           -- 後手段級（同上。カラム名は Dan だが段位限定ではない）
├── result: varchar(50)?         -- 対局結果
├── swarsGameKey: varchar(255) UNIQUE?  -- swars 対局キー（重複検知用・nullable）
├── playedAt: timestamp?         -- 対局日時（sourceTz で解釈した絶対時刻）
├── sourceTz: varchar(8)?        -- playedAt の解釈 TZ（"JST" 既定 / "UTC" は投入時指定。[04](./04-ingestion.md)）
├── analysisCompletedAt: timestamp?     -- 解析完了日時（INDEX）
├── analysisError: text?                -- 解析失敗理由（worker がエンジン失敗時に記録。ポイズンピル対策）
├── analysisRevision: int notNull default 0 -- 解析世代（reanalyze で +1。worker 報告の世代照合用）
├── memo: text?                         -- ユーザー自由記述メモ（PATCH /api/kifus/:id で編集）
├── source: enum notNull default 'manual'  -- 出所（'manual' | 'swars' | 'video'。[10](./10-video-analysis.md) §2.1）
├── subjectSide: enum?                  -- 主体の手番（'sente' | 'gote'。計画中。[10](./10-video-analysis.md) §3.3）
├── createdAt: timestamp
└── updatedAt: timestamp
```

- **`kifText` は原本**（KIF）。`usiMoves` は登録時に変換した派生物で、解析前でも盤面表示に使える（[05](./05-analysis.md)）。
- **`swarsGameKey`** は swars 由来棋譜の一意キー。UNIQUE 制約で**重複取得を検知**する（[04](./04-ingestion.md)）。
  KIF 貼り付け等では null。
- **`source`**: 棋譜の出所。動画解析（`'video'`）は自分の対局ではないため、
  🔒 **一覧・分析・統計のクエリは `source <> 'video'` を既定で強制する**（引数で外せる条件にしない。
  [10](./10-video-analysis.md) §2.2）。棋譜ビューアは共用する。
- **`sourceTz`**: `開始日時` にタイムゾーン欄が無い KIF を正しく並べるため、`playedAt` を解釈した TZ を記録する。
  投入時にユーザーが選択（`auto`/`JST`/`UTC`。**`auto` は JST**。署名からの UTC 推定は廃止＝[04](./04-ingestion.md)）。
  UTC のときは +9h 補正した絶対時刻を保存。
  swars 経路は `gameKey` 由来で常に `"JST"`。reanalyze はこの値を維持する（[04](./04-ingestion.md)）。
- **`analysisCompletedAt`** に INDEX。worker は「**未解析（`analysisCompletedAt IS NULL`）かつ失敗なし
  （`analysisError IS NULL`）の最古**」を引く（[05](./05-analysis.md)）。
- **`analysisError`**: worker がエンジンの異常終了/illegal move/timeout を検知したときに理由を記録する。これにより
  poll から除外され、**解析できない棋譜がキューを詰まらせない**（ポイズンピル対策。[05](./05-analysis.md) §1.1a）。
  再試行は `POST /api/kifus/:id/reanalyze`（`kifText` を再変換して `usiMoves`・メタを作り直し error をクリア。[04](./04-ingestion.md) §6）。
  **`analysisCompletedAt` と `analysisError` は排他**（同時に非 null にならない）: error は未完了時のみ記録し、
  解析結果のチャンクは error なし時のみ適用する（行ロック下で相互排他。重複取得があっても
  **この 2 つの状態が矛盾することはない**）。
  **完了済みの棋譜へのチャンクも受理しない**（＝完了後の解析結果は不変。遅れて届いたチャンクが
  完了済みの結果を部分的に上書きしうるため。作り直しは `reanalyze` の経路だけ。[05](./05-analysis.md) §1.1c）。
  - ⚠ ただし**完了前のチャンクの混在までは防がない**。`GET /api/worker/kifus` は lease を取らないので、
    2 つの worker が同じ棋譜・同じ世代を掴めば、1 棋譜の解析結果に複数実行の値が混ざる。
    **worker の単一インスタンス運用を前提として受ける**（並行解析には lease 列が要り、
    [05](./05-analysis.md) §1.1c のとおり承認範囲外）。
- **`analysisRevision`**: 解析世代。`reanalyze` で +1 する。`GET /api/worker/kifus` は現在の revision を返し、worker は
  `POST /api/worker/analyses` / `POST /api/worker/kifus/:id/error` に取得時 revision を添える。server は **同一 revision のときだけ**
  結果/失敗を適用する。これにより、reanalyze で状態をリセットした後に**実行中だった旧解析の報告が新状態を上書きするのを防ぐ**
  （旧成功で completed 復活・旧失敗で error 復活を弾く。[05](./05-analysis.md) §1.1a）。
- 対局メタ（sente/gote/dan/result/playedAt）は**一括取り込み・KIF 貼り付けの両経路とも登録時に抽出**して埋める
  （KIF 経路は `result` を終局マーカー＋手番 parity から導出。[04](./04-ingestion.md) §3）。取れなければ null。
- **`memo`** はユーザーの自由記述。棋譜詳細で編集し（`PATCH /api/kifus/:id`）、一覧は有無（`hasMemo`）のみ返す（[05](./05-analysis.md)）。

### 2.1 `kifuTactics`（戦型ラベル・計画中）

```
kifuTactics
├── kifuId: FK → kifus.id (CASCADE)
├── side: enum('sente','gote','both')  -- ラベルの帰属先（下記 §2.1.1）
├── label: varchar(32)                 -- 一次 / 二次ラベル名（例 "四間飛車" "角換わり"）
├── turn: int                          -- 成立手数（表示の抑制に使う。下記 §2.1.2）
├── PRIMARY KEY(kifuId, side, label)
└── INDEX(label)
```

- **`usiMoves` から導く派生値**（[01](./01-domain.md) §6）。**正は指し手列**であって、この表は
  絞り込みと集計を SQL で行うための索引にすぎない。
- **手番ごとに複数行**。1 局・1 手番に複数のラベルが立つ（`四間飛車` と `振り飛車` が同時に立つ）。
- **内部ラベル（`_` 始まり）は保存しない。** ユーザーに出さないうえ、指し手列から常に再計算できる。
- **成立手数（`turn`）は保存する。** 絞り込み・勝率集計には要らないが、**表示の抑制に要る**
  （§2.1.2）。振り直しで複数の振り先ラベルが立ったとき「最初に振った先だけ出す」を SQL のまま
  書けるようにする。判定側は全ラベルの成立手数を副産物として持っているので、捨てる方に手間がかかる。
  ⚠ **`turn` は表示のための順序であって、絞り込み条件に使わない。** 判定を更新すれば値が変わる
  派生値であり、「N 手目までに成立した棋譜」のような条件で使うと再判定のたびに結果が動く。
- **判定バージョンの列は持たない。** 判定ロジックを更新したら**全件を一括再判定**する
  （解析来歴を持たない立場と同じ。§7 決定済み）。
- **`usiMoves` が変われば必ず作り直す。** 投入時に加えて `reanalyze`（`kifText` の再変換）も対象で、
  **`kifus` の更新と `kifuTactics` の置換は同一トランザクション**に入れる（[01](./01-domain.md) §6.4 /
  [04](./04-ingestion.md) §6）。`usiMoves` が null になったときはラベルを空に置換する。
- **再判定は棋譜単位で原子的に置換する。** 旧ラベルの `DELETE` と新ラベルの一括 `INSERT` を
  **同一トランザクション**で実行し、**判定が成功した後にだけ**置換する。
  この表は一覧の絞り込みと勝率集計に使われるため、DELETE 済み・INSERT 前の状態が読まれると
  **その棋譜だけ黙って条件から外れ、件数や集計が静かに狂う**（エラーにならないので気づけない）。
  判定中の失敗で旧ラベルが消えたまま残るのも同じ理由で許容しない。
  一括再判定**全体**を単一トランザクションにする必要はない（棋譜ごとに独立して置換してよい）。
- **JSON 列（`kifus.tactics`）ではなく別テーブルにする。** 一覧の絞り込みは server 側の SQL で行い
  件数・ページングも同じ条件で数える、という確定事項（[04](./04-ingestion.md) §6.1）に素直に乗るため。
  `JSON_CONTAINS` でも書けるが索引が効かず、戦型別の勝率集計（横断集計）で JOIN 一本にならない。
- `label` は**表示名そのもの**を入れる（enum やコード値にしない）。判定側の定義が増えるたびに
  スキーマ変更を伴わせないため。表記ゆれは判定側（`shared`）の定義が単一の出所になることで防ぐ。
### 2.1.1 `side` はラベルの**帰属先**であって「立った手番」ではない

戦型ラベルは 3 通りの帰属を持つ（[01](./01-domain.md) §6.3）。`side` の読み方がそれぞれ違う。

| 種別 | `side` | 意味 | 例 |
|---|---|---|---|
| **手番固有** | `sente` / `gote` | **その側だけ**がその戦型 | 四間飛車・矢倉・筋違い角・横歩取り |
| **きっかけ帰属** | `sente` / `gote` | **双方がその戦型**で、`side` は**持ち込んだ側** | 角換わり |
| **対局帰属** | `both` | どちらのものでもない。1 行だけ持つ | 相掛かり |

- **きっかけ帰属を「役割ラベル」で表さない。** `角換わり` に加えて `角交換を挑んだ` /
  `角交換に応じた` を別ラベルとして持つ案もあったが、**1 局 3 行**になり、ラベルの種類も増える。
  `side` に持ち込んだ側を入れれば **1 行**で済み、「応じた側」は
  「角換わりが立っていて `side` が相手」から**導出できる**。
- **持ち込んだ側の決め方**: 角交換は「取る → 取り返す」の 2 手で完了するので、
  **先に角を持ち駒にした側**が仕掛けた側。`▲2二角成` も `△8八角成` も同じ規則で決まる。
- **相掛かりは `both`。** きっかけを定義できないため（[01](./01-domain.md) §6.3）。
- ⚠ **`side` の意味がラベルによって変わるので、絞り込みは種別を見て分ける。**
  判定側（`shared`）が「きっかけ帰属・対局帰属のラベル一覧」を単一の出所として持ち、
  表示・集計はそれを参照する。

| 用途 | 書き方 |
|---|---|
| この対局はその戦型か（手番を問わない） | `EXISTS (… WHERE label = ?)`。**`side` を見ない** |
| 自分がその戦型を実行した（手番固有） | `EXISTS (… WHERE label = ? AND side = :self)` |
| 自分から持ち込んだ / 持ち込まれた（きっかけ帰属） | `side = :self` / `side <> :self`。**`both` は現れない** |
| 一覧の絞り込み | 相関 `EXISTS`（JOIN しない）。JOIN は `count()` と LIMIT/OFFSET を壊す（[04](./04-ingestion.md) §6.1） |
| 手番別の集計（「振り飛車側の勝率」） | `side IN ('sente','gote')` を添える |

- **対局レベルの関係（`相居飛車` / `相振り飛車`）は保存しない。**
  `自分が振り飛車 AND 相手が居飛車` のように**双方の一次ラベルから導出できる**ため
  （[01](./01-domain.md) §6.3）。絞り込みでは `EXISTS` が 2 つ必要になるが、
  導出できる値を持たない方針（判定バージョンと同じ立場）に揃える。
  表示では判定結果からその場で出してよい。

### 2.1.2 表示の抑制 — 保存は全部、隠すのは表示だけ

**立ったラベルは全部保存する**（経由形も含む。[01](./01-domain.md) §6.3）。一覧・詳細で出す件数を
絞るのは**表示側の仕事**。

抑制は **per-side の表示タグにだけ**掛ける。**入力はどちらも「抑制前の全判定結果」**であって、
一方の出力をもう一方の入力にしない。

| | 対象 | 規則 | 入力 |
|---|---|---|---|
| **A** | per-side の表示タグ | **`implies` で含意される一般ラベルを隠す**（`石田流` が立てば `三間飛車` `振り飛車` を出さない）。残った**振り先ラベル**（中飛車 / 四間飛車 / 三間飛車 / 向かい飛車 / 右四間飛車 / 袖飛車）が複数あれば **`turn` が最小のものだけ**出す | 抑制前の全判定結果 |
| ~~**B**~~ | ~~対局レベルの表示~~ | **廃止**（2026-08-05）。`対抗形` `相居飛車` `相振り飛車` はどれも双方の per-side タグを見れば読めるので出さない。絞り込みの語彙としてのみ `RELATION_FILTERS` に残す | — |

⚠ **B を A の出力から導出してはいけない。** 関係ラベルは `振り飛車` / `居飛車` から導出するが、
A はその `振り飛車` を隠すことがある。**石田流 対 居飛車**の対局で A を先に適用してから B を
引くと、双方の `石田流` が `振り飛車` を隠しているために `相振り飛車` が漏れる。
A と B は独立した表示規則であって、パイプラインではない。

```sql
-- A の例: 振り先ラベルのうち最初に成立したものを取る
SELECT label FROM kifu_tactics
 WHERE kifu_id = ? AND side = ? AND label IN (…振り先ラベル…)
 ORDER BY turn LIMIT 1
```

- **`implies` は判定側（`shared`）がラベル定義と一緒に宣言する。** DB にも UI にも置かない。
  表記ゆれを防ぐために `label` の出所を `shared` に一本化しているのと同じ理由
  （§2.1 の `label` は表示名そのもの）。
- **`implies` は「こちらの判定同士の含意」でなければならない。** 「一般に A は B の一種」という
  戦法の分類ではなく、**A の判定条件が B の判定条件を必ず満たす**ことを指す。
  例: `石田流` はどちらの成立経路でも飛車が 7八を通るので `三間飛車` を必ず含意する。
  逆に `右四間飛車`（4八）と `袖飛車`（3八）は**振り飛車を含意しない**（振り先が 5筋より右）。
- **A の 2 つの規則は互いに衝突しない。** 「振り直しの結果として立つ戦法」は `石田流` のように
  **振り先ラベルを含意する**ので、`implies` の抑制が意味のある振り直し先を自動的に残す。
  意味のない振り直し（開戦直前に振り直しただけ）は振り先の抑制で消える。
- ⚠ **抑制した結果を保存し直さない。** 保存値は判定結果そのもので、表示のたびに抑制を適用する。
  抑制後を保存すると、経由形での絞り込み（「四間飛車から向かい飛車に振り直した対局」）ができなくなる。

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
| `moveNumber` が棋譜の局面であること | submit 時に **`0 <= moveNumber <= usiMoves.length` を検証**し、外れていれば 1 件でも書かずに 400（下記 ⚠） |
| 前世代の全消去 | **`reanalyze` の DELETE が唯一の経路**（`POST /api/kifus/:id/reanalyze`。submit 側は DELETE しない） |
| 完了の確定 | 件数が `usiMoves.length + 1` に達したときの `analysisCompletedAt`（submit と同一トランザクション内で server が判定） |

- ⚠ **完了を件数で決めるので、`moveNumber` の有効範囲は submit 側で担保する必要がある**。範囲外の行を
  受け入れると、**必要な局面が欠けたまま件数だけが `usiMoves.length + 1` に達して完了扱いになる**
  （例: 2 手の棋譜に `0 / 1 / 99` が入ると 3 件で完了）。完了すると poll から外れるため自動再開でも
  修復されない。範囲を保証すれば `UNIQUE(kifuId, moveNumber)` が値の重複を防ぐので、
  **件数 = 全局面数 ⇒ 全局面が揃っている**が成り立つ。
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
- ✅ **戦型ラベルは派生値・別テーブル・バージョン列なし**（2026-08-04）。`usiMoves` から常に再計算でき、
  判定を更新したら全件を一括再判定する。JSON 列ではなく `kifuTactics` に正規化して SQL の絞り込み・
  集計に乗せる（§2.1 / [01](./01-domain.md) §6）。
