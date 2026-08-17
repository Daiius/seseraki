import { useState } from 'react';
import type { InferResponseType } from 'hono/client';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { stateFromBytes, usiToJapaneseWithPiece } from 'shared';
import { client } from '../lib/honoClient';
import { BoardGrid, HandDisplay } from '../components/ShogiBoard';

/**
 * 局面検索（prd/10 §6.2）。**自分の対局と動画解析を横断して**、同じ局面を通った
 * 棋譜と、そこからの分岐を並べる。
 *
 * ⚠ **動画解析ページの中に置かない。** 検索の対象は動画解析だけではないので、
 * 「動画解析」の下に自分の棋譜が並ぶと名前と中身がずれる（prd/10 §6.2）。
 */
export interface PositionsSearch {
  /** 局面キー（SFEN の 盤 / 手番 / 持ち駒）。未指定なら初期局面 */
  pos?: string;
}

async function loadPosition(pos: string | undefined) {
  try {
    const res = await client.api.positions.$get({ query: { pos } });
    if (res.status === 404) {
      return { position: null, error: 'この局面を通った棋譜はまだ無い' };
    }
    if (!res.ok) return { position: null, error: `サーバーエラー (${res.status})` };
    return { position: await res.json(), error: null };
  } catch {
    return { position: null, error: 'サーバーに接続できません' };
  }
}

export const Route = createFileRoute('/positions')({
  validateSearch: (search: Record<string, unknown>): PositionsSearch => ({
    pos: typeof search.pos === 'string' && search.pos.length > 0 ? search.pos : undefined,
  }),
  loaderDeps: ({ search }) => ({ pos: search.pos }),
  loader: ({ deps }) => loadPosition(deps.pos),
  component: PositionsPage,
});

type Position = NonNullable<Awaited<ReturnType<typeof loadPosition>>['position']>;

/** 出所のバッジ。動画解析は自分の対局ではないので、一目で分かるようにする */
function SourceBadge({ source }: { source: Position['games'][number]['source'] }) {
  if (source === 'video') {
    return <span className="badge badge-secondary badge-sm whitespace-nowrap">動画</span>;
  }
  return <span className="badge badge-ghost badge-sm whitespace-nowrap">自分</span>;
}

/**
 * 一度に出す棋譜の行数。
 *
 * ⚠ **序盤の局面はどの棋譜も通る**ので、初手付近では到達が数百件になる。
 * 全部並べると画面が棋譜一覧で埋まり、**この画面の主役である分岐が見えなくなる**。
 * 総数は常に出したうえで、行は畳んでおく。
 */
const GAMES_PAGE = 20;

// ⚠ 200 の型に絞る。素の戻りは 404（`{ error }`）とのユニオンで、
// `res.ok` では絞り込めない
type Similar = InferResponseType<typeof client.api.positions.similar.$get, 200>;

/**
 * 近い局面（prd/10 §5.2）。**押されたときだけ取りに行く。**
 *
 * 完全一致は index seek だけで済むが、近さは手数帯ぶんの行を読んで距離を掛けるので
 * 桁違いに重い。局面を辿るたびに走らせると、辿ること自体が重くなる。
 */
function SimilarSection({
  sfen,
  onPick,
}: {
  sfen: string;
  onPick: (sfen: string) => void;
}) {
  const [state, setState] = useState<
    { kind: 'idle' } | { kind: 'loading' } | { kind: 'done'; data: Similar } | { kind: 'error' }
  >({ kind: 'idle' });

  const load = async () => {
    setState({ kind: 'loading' });
    try {
      const res = await client.api.positions.similar.$get({ query: { pos: sfen } });
      if (!res.ok) {
        setState({ kind: 'error' });
        return;
      }
      setState({ kind: 'done', data: await res.json() });
    } catch {
      setState({ kind: 'error' });
    }
  };

  return (
    <section>
      <h2 className="text-lg font-semibold mb-2">近い局面</h2>
      {state.kind === 'idle' && (
        <button type="button" className="btn btn-outline btn-sm" onClick={load}>
          近い局面を探す
        </button>
      )}
      {state.kind === 'loading' && (
        <span className="loading loading-dots loading-md" aria-label="探しています" />
      )}
      {state.kind === 'error' && (
        <div className="alert alert-warning">近い局面を取得できなかった</div>
      )}
      {state.kind === 'done' && (
        <>
          {/* ⚠ 文は組み立ててから出す。JSX で改行を挟むと語の間の空白が消える */}
          <p className="text-sm opacity-60 mb-2">
            {`${state.data.base.from}〜${state.data.base.to} 手目の局面 ${state.data.scanned} 件から、` +
              `この局面を通っていない ${state.data.matchedGames} 局が見つかった`}
            {/* 🔒 読み出しを打ち切ったら言う */}
            {state.data.truncated && '（走査の上限に当たったので、これで全部ではない）'}
          </p>
          {state.data.similar.length === 0 ? (
            <p className="text-sm opacity-60">近い局面は見つからなかった。</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="table table-sm table-zebra">
                <thead>
                  <tr>
                    <th className="whitespace-nowrap">違い</th>
                    <th>出所</th>
                    <th className="w-full">棋譜</th>
                    <th className="text-right whitespace-nowrap">到達</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {state.data.similar.map((s) => (
                    <tr key={`${s.kifuId}-${s.moveNumber}`}>
                      <td className="whitespace-nowrap">
                        <span className="font-mono">{s.distance}</span>
                        <span className="text-xs opacity-60 ml-1">
                          （盤 {81 - s.boardDiff}/81
                          {s.handsDiff > 0 && ` ・持駒 ${s.handsDiff}`}）
                        </span>
                      </td>
                      <td>
                        <SourceBadge source={s.source} />
                      </td>
                      <td className="w-full">{s.title}</td>
                      <td className="text-right whitespace-nowrap">
                        {s.moveNumber} 手目
                      </td>
                      <td className="whitespace-nowrap">
                        <button
                          type="button"
                          className="btn btn-ghost btn-xs"
                          onClick={() => onPick(s.sfen)}
                        >
                          この局面へ
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function PositionsPage() {
  const { position, error } = Route.useLoaderData();

  if (error || !position) {
    return (
      <div className="container mx-auto p-4">
        <div className="alert alert-warning">{error}</div>
        <Link to="/positions" search={{ pos: undefined }} className="btn btn-sm mt-4">
          初期局面へ
        </Link>
      </div>
    );
  }

  // ⚠ key を付けて局面ごとに作り直す。付けないと、別の局面へ降りたときに
  // 「さらに表示」で広げた状態がそのまま残る
  return <PositionView key={position.sfen} position={position} />;
}

function PositionView({ position }: { position: Position }) {
  const navigate = useNavigate();
  const [shown, setShown] = useState(GAMES_PAGE);
  const visible = position.games.slice(0, shown);

  // 索引が持つのはバイト列なので、盤を描くにはここで局面へ戻す（prd/10 §6.2）
  const state = stateFromBytes(
    Uint8Array.from(position.board),
    Uint8Array.from(position.hands),
    position.sideToMove,
  );
  const toMove = position.sideToMove === 'b' ? '▲先手番' : '△後手番';

  const goTo = (pos: string) =>
    navigate({ to: '/positions', search: { pos } });

  return (
    <div className="container mx-auto p-4">
      <div className="flex items-baseline justify-between gap-4 mb-4">
        <h1 className="text-2xl font-bold">局面検索</h1>
        {!position.isInitial && (
          <Link to="/positions" search={{ pos: undefined }} className="btn btn-ghost btn-sm">
            初期局面へ
          </Link>
        )}
      </div>

      {/* ⚠ 横に並べない。盤は固定幅（9 マス）で、container の幅では隣が潰れる */}
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-2 w-fit">
          <HandDisplay hand={state.hand.gote} side="gote" name={null} />
          <BoardGrid state={state} lastMoveTo={null} flipped={false} />
          <HandDisplay hand={state.hand.sente} side="sente" name={null} />
          <p className="text-sm opacity-70 text-center">{toMove}</p>
        </div>

        <div className="flex flex-col gap-6">
          <section>
            <h2 className="text-lg font-semibold mb-2">
              この局面からの分岐
              <span className="text-sm font-normal opacity-60 ml-2">
                {position.branches.length} 通り
              </span>
            </h2>
            {position.branches.length === 0 ? (
              <p className="text-sm opacity-60">
                ここで棋譜が終わっている（次の手が記録されていない）。
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {position.branches.map((b) => (
                  <button
                    key={b.sfen}
                    type="button"
                    className="btn btn-outline btn-sm"
                    onClick={() => goTo(b.sfen)}
                  >
                    <span className="font-mono">
                      {b.move ? usiToJapaneseWithPiece(state, b.move) : '?'}
                    </span>
                    <span className="badge badge-sm">{b.games}</span>
                  </button>
                ))}
              </div>
            )}
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-2">
              この局面を通った棋譜
              <span className="text-sm font-normal opacity-60 ml-2">
                {position.total} 件
              </span>
              {/* 🔒 打ち切りを黙らない。出ている数が全部だと誤読されるため。
                  ⚠ **文言は実際の並びに合わせる。** 第一キーは到達手数なので
                  「新しい N 件」ではない——手順前後で到達が遅くなった対局は、
                  新しくても上限の外に出る */}
              {position.hasMore && (
                <span className="text-sm font-normal opacity-60 ml-2">
                  （到達が早い順に {position.games.length} 件まで・同手数では新しい順）
                </span>
              )}
            </h2>
            <div className="overflow-x-auto">
              <table className="table table-sm table-zebra">
                <thead>
                  <tr>
                    <th>出所</th>
                    <th className="w-full">棋譜</th>
                    <th className="text-right whitespace-nowrap">到達</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {visible.map((g) => (
                    <tr key={`${g.kifuId}-${g.moveNumber}`}>
                      <td>
                        <SourceBadge source={g.source} />
                      </td>
                      <td className="w-full">{g.title}</td>
                      <td className="text-right whitespace-nowrap">
                        {g.moveNumber} 手目
                      </td>
                      <td className="whitespace-nowrap">
                        <Link
                          to="/kifus/$id"
                          params={{ id: String(g.kifuId) }}
                          className="btn btn-ghost btn-xs"
                        >
                          開く
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {visible.length < position.games.length && (
              <button
                type="button"
                className="btn btn-ghost btn-sm mt-2"
                onClick={() => setShown(shown + GAMES_PAGE)}
              >
                さらに {Math.min(GAMES_PAGE, position.games.length - shown)} 件を表示
                <span className="opacity-60">
                  （残り {position.games.length - shown}）
                </span>
              </button>
            )}
          </section>

          <SimilarSection sfen={position.sfen} onPick={goTo} />

          <details className="collapse collapse-arrow bg-base-200">
            <summary className="collapse-title text-sm">局面キー（SFEN）</summary>
            <div className="collapse-content">
              <pre className="text-xs font-mono whitespace-pre-wrap break-all">
                {position.sfen}
              </pre>
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}
