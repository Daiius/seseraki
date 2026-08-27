import { type ReactNode } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { buildPositions } from 'shared';
import { AnalyzingRadial } from '../components/AnalyzingRadial';
import { AnalyzingAlert } from '../components/AnalyzingAlert';
import { CopyButton } from '../components/CopyButton';
import { ClipboardIcon } from '../components/icons';
import { ShogiBoard } from '../components/ShogiBoard';
import { DEFAULT_THRESHOLDS } from '../lib/cpl';

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

/** ケースを 390px（iPhone 14 の論理幅）の枠に入れる。ギャラリーはデスクトップ幅で開くため */
function Phone({ children }: { children: ReactNode }) {
  return <div className="max-w-[390px] overflow-hidden">{children}</div>;
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
    </div>
  );
}
