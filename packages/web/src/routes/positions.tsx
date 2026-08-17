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

function PositionsPage() {
  const { position, error } = Route.useLoaderData();
  const navigate = useNavigate();

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
                {position.games.length} 件
              </span>
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
                  {position.games.map((g) => (
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
          </section>

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
