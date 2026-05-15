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
import { KifuExport } from '../../components/KifuExport';
import { KifuMemo } from '../../components/KifuMemo';

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

  // 読み筋を盤面追跡しながら変換（pv[0] は候補手と等しい完全列）
  const pvToJapanese = (pv: string[], moveNumber: number) => {
    let state = getState(moveNumber);
    if (!state) return pv.join(' ');

    const parts: string[] = [];
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
        <div className="dropdown dropdown-end ml-auto">
          <button
            tabIndex={0}
            className="btn btn-ghost btn-sm"
            aria-label="メニュー"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2}
              stroke="currentColor"
              className="size-5"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.75a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5ZM12 12.75a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5ZM12 18.75a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5Z" />
            </svg>
          </button>
          <ul
            tabIndex={0}
            className="dropdown-content menu menu-sm bg-base-100 rounded-box z-20 mt-1 w-32 p-1 shadow"
          >
            <li>
              <button onClick={handleDelete} className="text-error">
                削除
              </button>
            </li>
          </ul>
        </div>
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
                              {c.pv ? pvToJapanese(c.pv, a.moveNumber) : ''}
                            </td>
                          </tr>
                        ));
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </details>

            <details className="collapse collapse-arrow bg-base-200">
              <summary className="collapse-title text-lg font-semibold">
                LLM 解説用テキスト
              </summary>
              <div className="collapse-content">
                <KifuExport
                  kifu={{
                    title: kifu.title,
                    usiMoves,
                    sente: kifu.sente,
                    gote: kifu.gote,
                    senteDan: kifu.senteDan,
                    goteDan: kifu.goteDan,
                    result: kifu.result,
                    playedAt: kifu.playedAt,
                    analyses: kifu.analyses,
                  }}
                />
              </div>
            </details>
          </>
        )}

        <details className="collapse collapse-arrow bg-base-200">
          <summary className="collapse-title text-lg font-semibold">
            メモ
          </summary>
          <div className="collapse-content">
            <KifuMemo kifuId={kifu.id} memo={kifu.memo} />
          </div>
        </details>
      </div>
    </div>
  );
}
