import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import clsx from 'clsx';
import { client } from '../../lib/honoClient';
import { turnSymbol, formatScore, detectBlunders } from '../../lib/usi';
import {
  buildPositions,
  usiToJapaneseWithPiece,
  applyMove,
  type BoardState,
} from '../../lib/board';
import { ShogiBoard } from '../../components/ShogiBoard';

export const Route = createFileRoute('/kifus/$id')({
  loader: async ({ params }) => {
    const res = await client.kifus[':id'].$get({
      param: { id: params.id },
    });
    if (!res.ok) throw new Error('Kifu not found');
    return await res.json();
  },
  component: KifuDetailPage,
});

function KifuDetailPage() {
  const kifu = Route.useLoaderData();
  const navigate = useNavigate();

  const usiMoves: string[] = kifu.usiMoves ?? [];

  // USI 指し手列から盤面を構築
  const positions = buildPositions(usiMoves);

  // moveNumber → その局面の BoardState
  const getState = (moveNumber: number): BoardState | undefined =>
    positions[moveNumber];

  // USI 手を駒名付き日本語に変換（盤面がなければフォールバック）
  const toJapanese = (usi: string, state?: BoardState) =>
    state ? usiToJapaneseWithPiece(state, usi) : usi;

  // 読み筋を盤面追跡しながら変換
  const pvToJapanese = (
    pv: string[],
    moveNumber: number,
    firstMove: string,
  ) => {
    let state = getState(moveNumber);
    if (!state) return pv.join(' ');

    const parts: string[] = [];
    // 最初の候補手を適用
    state = applyMove(state, firstMove);

    for (let j = 0; j < pv.length; j++) {
      const pvMoveNum = moveNumber + j;
      const turn = turnSymbol(pvMoveNum);
      parts.push(`${turn}${usiToJapaneseWithPiece(state, pv[j])}`);
      state = applyMove(state, pv[j]);
    }
    return parts.join(' ');
  };

  const handleDelete = async () => {
    if (!confirm('この棋譜を削除しますか？')) return;
    const res = await client.kifus[':id'].$delete({
      param: { id: String(kifu.id) },
    });
    if (res.ok) navigate({ to: '/' });
  };

  const blunders = detectBlunders(kifu.analyses, usiMoves);

  const getPositionEval = (a: (typeof kifu.analyses)[number]) => {
    const best = a.candidates.find((c) => c.rank === 1);
    if (!best) return null;
    return { scoreType: best.scoreType, scoreValue: best.scoreValue };
  };

  return (
    <div>
      <div className="flex items-center gap-4 mb-4">
        <Link to="/" className="btn btn-ghost btn-sm">
          ← 一覧
        </Link>
        <h2 className="text-2xl font-bold">{kifu.title}</h2>
        <button onClick={handleDelete} className="btn btn-error btn-sm ml-auto">
          削除
        </button>
      </div>

      <div className="flex flex-col gap-6">
        {usiMoves.length > 0 && (
          <ShogiBoard usiMoves={usiMoves} analyses={kifu.analyses} sente={kifu.sente} gote={kifu.gote} />
        )}

        <details className="collapse collapse-arrow bg-base-200">
          <summary className="collapse-title text-lg font-semibold">
            KIF
          </summary>
          <div className="collapse-content">
            <pre className="text-sm font-mono whitespace-pre-wrap">
              {kifu.kifText}
            </pre>
          </div>
        </details>

        {kifu.analyses.length > 0 && (
          <>
            <details className="collapse collapse-arrow bg-base-200">
              <summary className="collapse-title text-lg font-semibold">
                局面評価値
              </summary>
              <div className="collapse-content">
                <div className="overflow-x-auto">
                  <table className="table table-sm">
                    <thead>
                      <tr>
                        <th>手数</th>
                        <th>指し手</th>
                        <th>局面評価値（先手視点）</th>
                        <th>最善手</th>
                      </tr>
                    </thead>
                    <tbody>
                      {kifu.analyses.map((a) => {
                        const posEval = getPositionEval(a);
                        const best = a.candidates.find((c) => c.rank === 1);
                        const turn = turnSymbol(a.moveNumber);
                        const state = getState(a.moveNumber);
                        const played = usiMoves[a.moveNumber];
                        const isBestMove =
                          best && played && best.move === played;
                        return (
                          <tr key={a.id}>
                            <td>{a.moveNumber}</td>
                            <td>
                              {played
                                ? `${turn}${toJapanese(played, state)}`
                                : '-'}
                            </td>
                            <td>
                              {posEval
                                ? formatScore(
                                    posEval.scoreType,
                                    posEval.scoreValue,
                                    a.moveNumber,
                                  )
                                : '-'}
                            </td>
                            <td>
                              {best ? (
                                <span
                                  className={clsx(
                                    !isBestMove && (blunders.has(a.moveNumber) ? 'text-error' : 'text-warning'),
                                  )}
                                >
                                  {turn}
                                  {toJapanese(best.move, state)}
                                  {!isBestMove && (
                                    blunders.has(a.moveNumber)
                                      ? ` ${turn}`
                                      : ' ※'
                                  )}
                                </span>
                              ) : (
                                '-'
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </details>

            <details className="collapse collapse-arrow bg-base-200">
              <summary className="collapse-title text-lg font-semibold">
                候補手詳細
              </summary>
              <div className="collapse-content">
                <div className="overflow-x-auto">
                  <table className="table table-sm">
                    <thead>
                      <tr>
                        <th>手数</th>
                        <th>指し手</th>
                        <th>順位</th>
                        <th>候補手</th>
                        <th>評価値</th>
                        <th>深さ</th>
                        <th>読み筋</th>
                      </tr>
                    </thead>
                    <tbody>
                      {kifu.analyses.flatMap((a) => {
                        const turn = turnSymbol(a.moveNumber);
                        const state = getState(a.moveNumber);
                        const played = usiMoves[a.moveNumber];
                        return a.candidates.map((c, i) => (
                          <tr key={`${a.id}-${c.rank}`}>
                            {i === 0 && (
                              <>
                                <td rowSpan={a.candidates.length}>
                                  {a.moveNumber}
                                </td>
                                <td rowSpan={a.candidates.length}>
                                  {played
                                    ? `${turn}${toJapanese(played, state)}`
                                    : '-'}
                                </td>
                              </>
                            )}
                            <td>{c.rank}</td>
                            <td>
                              {turn}
                              {toJapanese(c.move, state)}
                            </td>
                            <td>
                              {formatScore(
                                c.scoreType,
                                c.scoreValue,
                                a.moveNumber,
                              )}
                            </td>
                            <td>{c.depth}</td>
                            <td className="font-mono text-xs">
                              {c.pv
                                ? pvToJapanese(c.pv, a.moveNumber, c.move)
                                : ''}
                            </td>
                          </tr>
                        ));
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </details>
          </>
        )}
      </div>
    </div>
  );
}
