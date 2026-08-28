import { type ReactNode } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { buildPositions } from 'shared';
import { AnalyzingRadial } from '../components/AnalyzingRadial';
import { AnalyzingAlert } from '../components/AnalyzingAlert';
import { CopyButton } from '../components/CopyButton';
import { ClipboardIcon } from '../components/icons';
import { ShogiBoard } from '../components/ShogiBoard';
import { StudyBoard } from '../components/StudyBoard';
import { BoardControls } from '../components/BoardControls';
import type { EvalState } from '../lib/positionEval';
import { DEFAULT_THRESHOLDS } from '../lib/cpl';
import {
  applyStudyMoves,
  createStudySession,
  squareOfUsi,
  tapHand,
  tapSquare,
  undo,
  undoAll,
} from '../lib/study';

/**
 * DEV 専用の UI ギャラリー。特定の表示状態（解析中など）を、認証も API も loader も通さず
 * props を手で与えて描画するための置き場。Playwright MCP でモバイル幅にリサイズして
 * スクリーンショットを撮り、レイアウトの折り返しや揃えを目視確認するのに使う。
 *
 * 本番では中身を出さない（`import.meta.env.DEV` ガード）。認証バイパスも `__root` 側で
 * DEV 限定にしてある。新しい表示を足したら、ここに 1 ケース追加すると撮って確認できる。
 */
export const Route = createFileRoute('/dev-gallery')({
  component: Gallery,
});

function Case({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold text-base-content/70">{title}</h2>
      <div className="rounded-box border border-base-300 p-4">{children}</div>
    </section>
  );
}

/**
 * 棋譜ビューアのケース用の指し手。
 * `▲７六歩 → △３四歩 → ▲２二角成` の角交換。3 手目が **`usiToJapaneseWithPiece` が返す
 * 最長の形**（成りを伴う移動 = `２二角成(88)`。駒打ちや不成はこれより短い）。
 *
 * 盤面はハードコードせず、実データと同じ経路（`shared` の `buildPositions`）で
 * 指し手から導出する（盤面追跡の実装が変わってもギャラリーが嘘をつかないように）。
 */
const KIFU_MOVES = ['7g7f', '3c3d', '8h2b+'];
const KIFU_POSITIONS = buildPositions(KIFU_MOVES);

/** 情報行の見え方を固定するための最小の解析結果（rank 1 のみ・PV は任意） */
function analysisAt(
  moveNumber: number,
  scoreType: 'cp' | 'mate',
  scoreValue: number,
  move: string,
  pv: string[] | null = null,
) {
  return {
    id: moveNumber + 1,
    moveNumber,
    candidates: [
      {
        id: (moveNumber + 1) * 10,
        rank: 1,
        move,
        scoreType,
        scoreValue,
        pv,
        depth: 24,
      },
    ],
  };
}

/**
 * ケースを 390px（iPhone 14 の論理幅）の枠に入れる。ギャラリーはデスクトップ幅で開くため。
 *
 * ⚠ **この枠は「デスクトップ幅で並べて眺める」ためのもので、実画面の再現ではない。**
 * 中身の `md:` はビューポート幅で効くので、デスクトップ幅で開くと
 * **`md:` の見た目に 390px の幅制約だけが乗った実在しない状態**になる（盤面もクリップされる）。
 * 折り返し・truncate を確かめるときは**ブラウザの幅そのものを 390px にする**。
 */
function Phone({ children }: { children: ReactNode }) {
  return (
    <div>
      <p className="mb-2 text-xs text-base-content/60">
        ⚠ ブラウザ幅を 390px にして見ること。デスクトップ幅のままだと、md 以上の見た目に
        390px の幅制約だけが乗った実在しない状態になる（実画面の再現にならない）。
      </p>
      <div className="max-w-[390px] overflow-hidden">{children}</div>
    </div>
  );
}

function KifuCase({
  initialMoveIndex,
  analyses,
}: {
  initialMoveIndex: number;
  analyses: ReturnType<typeof analysisAt>[];
}) {
  return (
    <Phone>
      <ShogiBoard
        usiMoves={KIFU_MOVES}
        positions={KIFU_POSITIONS}
        analyses={analyses}
        sente="先手"
        gote="後手"
        subjectSide={null}
        thresholds={DEFAULT_THRESHOLDS}
        initialMoveIndex={initialMoveIndex}
      />
    </Phone>
  );
}

/**
 * 検討盤（prd/12 §3）のケース。
 *
 * 盤面はここでもハードコードせず、`buildPositions` で作った局面に**実際のタップと同じ経路**
 * （`applyStudyMoves` / `tapSquare`）を通して状態を作る。操作モデルを変えたらここも
 * 一緒に壊れるので、ギャラリーが嘘をつかない。
 *
 * コントローラー行も**実物と同じ `BoardControls`** を出す（prd/12 §3.1 で検討中は
 * ◀ ▶ が undo / redo になるので、押せる・押せないの見え方をここで確かめる）。
 */
function StudyCase({
  session,
  evalState,
}: {
  session: Parameters<typeof StudyBoard>[0]['initialSession'];
  evalState?: EvalState;
}) {
  return (
    <Phone>
      <StudyBoard
        baseState={KIFU_POSITIONS[0]}
        baseKey="gallery"
        baseLastMoveTo={null}
        flipped={false}
        sente="先手"
        gote="後手"
        initialSession={session}
        initialEval={evalState}
      >
        {(study) => (
          <BoardControls
            study={study}
            moveIndex={0}
            totalMoves={KIFU_MOVES.length}
            branchActive={false}
            onGoTo={() => {}}
            onFlip={() => {}}
          />
        )}
      </StudyBoard>
    </Phone>
  );
}

/** 評価結果の見え方を固定するための候補手（スコアは**手番側から見た値**） */
const STUDY_CANDIDATES = [
  { rank: 1, move: '3c3d', scoreType: 'cp', scoreValue: 42, pv: ['3c3d', '2f2e', '8c8d'], depth: 22 },
  { rank: 2, move: '8c8d', scoreType: 'cp', scoreValue: 18, pv: ['8c8d', '2e2d'], depth: 22 },
  { rank: 3, move: '4a3b', scoreType: 'cp', scoreValue: -35, pv: ['4a3b'], depth: 21 },
];

function Gallery() {
  if (!import.meta.env.DEV) return null;
  return (
    <div className="space-y-8">
      <p className="text-sm text-base-content/70">
        DEV 専用の UI ギャラリー。表示状態を props で固定して並べています（本番では表示されません）。
      </p>

      <Case title="一覧・状態セル（解析中の円環）">
        {/* 実際の状態セル（`index.tsx` の `flex gap-1 items-center`）の並びを再現し、
            他バッジと同居してもモバイル幅で折り返さないかを見る */}
        <div className="flex gap-1 items-center">
          <span className="badge badge-soft badge-success badge-sm">勝</span>
          <AnalyzingRadial analyzed={12} total={150} />
          <span className="badge badge-sm bg-info/50 text-info-content">●</span>
        </div>
      </Case>

      <Case title="一覧・円環の進行度（0% / 25% / 100%）">
        <div className="flex gap-4 items-center">
          <AnalyzingRadial analyzed={0} total={150} />
          <AnalyzingRadial analyzed={38} total={150} />
          <AnalyzingRadial analyzed={150} total={150} />
        </div>
      </Case>

      <Case title="詳細・解析中 alert（文言と progress の縦中央揃え）">
        <AnalyzingAlert analyzed={12} total={150} agoText="3秒前に更新" />
      </Case>

      <Case title="コピーボタン（モバイルはアイコンのみ・sm+ でラベル）">
        <div className="flex flex-wrap gap-2">
          <CopyButton text="サンプル" label="KIF をコピー" className="btn-outline" />
          <CopyButton text="サンプル" label="クリップボードにコピー" className="btn-primary" />
        </div>
      </Case>

      <Case title="ペーストボタン（登録画面の KIF 欄ラベル右）">
        {/* new.tsx と同じマークアップ。モバイルはアイコンのみ */}
        <button
          type="button"
          className="btn btn-xs btn-ghost gap-1"
          aria-label="クリップボードからペースト"
        >
          <ClipboardIcon className="size-4" />
          <span className="hidden sm:inline">クリップボードからペースト</span>
        </button>
      </Case>

      {/*
        棋譜ビューアの情報行。**符号・評価値がどれだけ長くなっても、下の操作ボタン行の
        縦位置が動かないこと**を見るためのケース（最短 / 中間 / 最長を並べる）。
        以前は情報行が `flex-wrap` で、長い符号 + 評価値のときに右ブロック
        （この局面を探す / 手数 / 分岐バッジ）が折り返して行が 2 行になり、
        操作ボタン行が丸ごと下へずれていた。
      */}
      <Case title="棋譜・情報行 最短（初期局面・評価値なし）">
        <KifuCase initialMoveIndex={0} analyses={[]} />
      </Case>

      <Case title="棋譜・情報行 中間（通常の符号 + 数値の評価値）">
        {/* moveNumber 1 は後手番なので、保存値 -120 が先手視点 +120 として出る */}
        <KifuCase
          initialMoveIndex={1}
          analyses={[analysisAt(1, 'cp', -120, '3c3d')]}
        />
      </Case>

      <Case title="棋譜・情報行 最長（成りの符号 + 詰み評価・分岐は操作で出す）">
        {/*
          3 手目 `▲２二角成(88)` + `先手勝ち(15手詰)`。moveNumber 3 は後手番なので
          mate -15 が先手視点の 15 手詰になる。
          moveNumber 2 の候補手には PV を持たせてあり、「分岐を進む」を押すと
          **分岐バッジが増えた最長状態**（符号・詰み評価はそのまま）になる。
        */}
        <KifuCase
          initialMoveIndex={3}
          analyses={[
            analysisAt(2, 'mate', 15, '8h2b+', ['8h2b+', '3a2b', 'B*4e']),
            analysisAt(3, 'mate', -15, '2b3a'),
          ]}
        />
      </Case>

      {/*
        検討盤（prd/12 §3）。⚠ **盤マスは幅と高さから算出する**ので、この枠の中では
        実寸にならない（ビューポート基準）。マスの大きさを見るときはブラウザ幅そのものを変える。
      */}
      <Case title="検討・盤の駒を選択中（上下の駒台が受け皿になる）">
        {/*
          7七の歩を選んだ状態。**動かすまでは今までの画面と同じ**＝パネルが無い。
          🔴 盤の駒を選んでいる間は**上下の駒台の空き部分が受け皿として光る**
          （prd/12 §3.2・駒箱の代わり）。叩けばその側の持ち駒になる。
          ⚠ 選んでいないときは装飾が出ないこと（他のケースと見比べる）。
        */}
        <StudyCase
          session={tapSquare(createStudySession(KIFU_POSITIONS[0]), squareOfUsi('7g'))}
        />
      </Case>

      <Case title="検討・駒台へ移した後（駒箱は無い）">
        {/*
          7七の歩を後手の駒台へ移した状態。**盤から抜いた駒の行き先は駒台だけ**で、
          駒箱は UI に持たない（prd/12 §3.2・決定 2026-08-28）。
        */}
        <StudyCase
          session={tapHand(
            tapSquare(createStudySession(KIFU_POSITIONS[0]), squareOfUsi('7g')),
            'gote',
          )}
        />
      </Case>

      {/*
        🔴 検討中はコントローラー行が検討の操作になる（prd/12 §3.1・決定 2026-08-28）。
        ◀ ▶ = undo / redo、≪ ≫ = 検討の起点 / 最後へ、スライダーは無効。
        3 手進めて 1 手戻した状態なので、**◀ も ▶ も押せる**（両端でないこと）を見る。
      */}
      <Case title="検討・一部 undo した状態（◀ ▶ が undo / redo）">
        <StudyCase
          session={undo(applyStudyMoves(KIFU_POSITIONS[0], ['2g2f', '8c8d', '2f2e']))}
        />
      </Case>

      <Case title="検討・起点まで戻した状態（◀ は無効・検討は続く）">
        {/* 起点まで戻しても検討からは抜けない（「検討中」バッジは出たまま） */}
        <StudyCase
          session={undoAll(applyStudyMoves(KIFU_POSITIONS[0], ['2g2f', '8c8d']))}
        />
      </Case>

      <Case title="検討・持ち駒を選択中（盤のマスを叩くと打てる）">
        {/*
          持ち駒は**盤のマスと同じ寸法**で並び、枚数は右上に上付きで出る（prd/12 §3.2）。
          ▲８八角で２二の角を取り、その角を選んだ状態。選択の見せ方は盤の選択マスと同じ。
        */}
        <StudyCase
          session={tapHand(applyStudyMoves(KIFU_POSITIONS[0], ['8h2b']), 'sente', 'B')}
        />
      </Case>

      <Case title="検討中（駒を動かして操作パネルが出た状態）">
        {/* ▲２六歩まで進めた検討。パネルは**コントローラー行より下**に出る位置にある */}
        <StudyCase session={applyStudyMoves(KIFU_POSITIONS[0], ['2g2f'])} />
      </Case>

      {/*
        評価結果の先頭に「この局面の評価値」が 1 つ出る。局面評価は rank 1 のスコア、
        名指し評価はその手のスコアで、**同じ場所に同じ形**で出す。
        ⚠ 視点は手番側（prd/12 §2.3）。`base` の手番が後手なら符号が反転して見える。
      */}
      <Case title="検討・局面評価の結果（出所 = エンジン）">
        <StudyCase
          session={applyStudyMoves(KIFU_POSITIONS[0], ['2g2f'])}
          evalState={{
            kind: 'done',
            mode: 'position',
            base: KIFU_POSITIONS[1],
            candidates: STUDY_CANDIDATES,
            source: 'engine',
            fallback: false,
          }}
        />
      </Case>

      <Case title="検討・名指し評価の結果（出所 = 既存解析・咎め筋つき）">
        <StudyCase
          session={applyStudyMoves(KIFU_POSITIONS[0], ['2g2f'])}
          evalState={{
            kind: 'done',
            mode: 'move',
            base: KIFU_POSITIONS[0],
            candidates: [
              {
                rank: 1,
                move: '2g2f',
                scoreType: 'cp',
                scoreValue: -60,
                pv: ['2g2f', '8c8d', '2f2e', '8d8e'],
                depth: 20,
              },
            ],
            source: 'kifu',
            fallback: true,
          }}
        />
      </Case>

      <Case title="検討・評価値が詰みのとき（見出しの最長形）">
        {/*
          `先手勝ち(15手詰)` は評価値の表示で最も長くなる形。見出しの行が折り返しても
          結果ブロックの中に収まり、上の操作パネル・コントローラー行が動かないことを見る。
          ⚠ base（KIFU_POSITIONS[1]）は後手番なので、手番視点の +15 は後手の勝ちになる。
        */}
        <StudyCase
          session={applyStudyMoves(KIFU_POSITIONS[0], ['2g2f'])}
          evalState={{
            kind: 'done',
            mode: 'position',
            base: KIFU_POSITIONS[1],
            candidates: [
              {
                rank: 1,
                move: '3c3d',
                scoreType: 'mate',
                scoreValue: 15,
                pv: ['3c3d'],
                depth: 30,
              },
            ],
            source: 'engine',
            fallback: false,
          }}
        />
      </Case>

      <Case title="検討・評価後に局面を変えた（値は消し、手がかりだけ残す）">
        {/*
          🔴 実機で分かりにくかった状態。評価結果が出ている盤で駒を動かすと、
          以前は結果ブロックが**黙って消える**だけで「もう評価できないのか」と読めた。
          値そのものは出さず（別の局面の値を混ぜない。prd/12 §2.6）、
          「もう一度評価できる」ことだけを結果ブロックのあった場所に出す。
        */}
        <StudyCase
          session={applyStudyMoves(KIFU_POSITIONS[0], ['2g2f', '8c8d'])}
          evalState={{ kind: 'stale' }}
        />
      </Case>

      <Case title="検討・評価待ち / 検証で弾かれた局面">
        <div className="flex flex-col gap-4">
          <StudyCase
            session={applyStudyMoves(KIFU_POSITIONS[0], ['2g2f'])}
            evalState={{ kind: 'loading', mode: 'move' }}
          />
          <StudyCase
            session={applyStudyMoves(KIFU_POSITIONS[0], ['2g2f'])}
            evalState={{
              kind: 'invalid',
              violations: [
                { code: 'two_pawns', message: '先手の歩が5筋に2枚あります（二歩）' },
              ],
            }}
          />
        </div>
      </Case>
    </div>
  );
}
