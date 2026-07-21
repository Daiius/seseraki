import {
  createFileRoute,
  Link,
  useNavigate,
  useRouter,
} from '@tanstack/react-router';
import clsx from 'clsx';
import { client } from '../../lib/honoClient';
import { turnSymbol, formatScore, detectBlunders } from '../../lib/usi';
import {
  buildPositions,
  usiToJapaneseWithPiece,
  type BoardState,
} from '../../lib/board';
import { ShogiBoard } from '../../components/ShogiBoard';
import { KifuExport } from '../../components/KifuExport';
import { KifuMemo } from '../../components/KifuMemo';
import { LazyDetails } from '../../components/LazyDetails';

export const Route = createFileRoute('/kifus/$id')({
  loader: async ({ params }) => {
    const res = await client.api.kifus[':id'].$get({
      param: { id: params.id },
    });
    if (!res.ok) throw new Error('Kifu not found');
    return await res.json();
  },
  component: KifuDetailPage,
});

/** 局面評価値テーブルが必要とする解析データ（loader の戻り値の部分集合） */
interface Analysis {
  id: number;
  moveNumber: number;
  candidates: {
    rank: number;
    move: string;
    scoreType: string;
    scoreValue: number;
  }[];
}

function KifuDetailPage() {
  const kifu = Route.useLoaderData();
  const navigate = useNavigate();
  const router = useRouter();

  const usiMoves: string[] = kifu.usiMoves ?? [];

  // USI 指し手列から盤面を構築。全局面はここで 1 度だけ作り、盤面・表へ配る
  const positions = buildPositions(usiMoves);

  const handleDelete = async () => {
    if (!confirm('この棋譜を削除しますか？')) return;
    const res = await client.api.kifus[':id'].$delete({
      param: { id: String(kifu.id) },
    });
    if (res.ok) navigate({ to: '/' });
  };

  // kifText を再変換して解析状態をリセットし、worker に拾い直させる。
  // パーサ修正後の既存棋譜の復旧・失敗棋譜の再試行を兼ねる。
  const handleReanalyze = async () => {
    const res = await client.api.kifus[':id'].reanalyze.$post({
      param: { id: String(kifu.id) },
    });
    if (res.ok) router.invalidate();
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
              <button onClick={handleReanalyze}>再解析</button>
            </li>
            <li>
              <button onClick={handleDelete} className="text-error">
                削除
              </button>
            </li>
          </ul>
        </div>
      </div>

      <div className="flex flex-col gap-6">
        {kifu.analysisError && (
          <div className="alert alert-error flex items-start gap-3">
            <div className="flex-1">
              <div className="font-semibold">解析失敗</div>
              <div className="text-sm font-mono break-all opacity-90">
                {kifu.analysisError}
              </div>
            </div>
            <button className="btn btn-sm" onClick={handleReanalyze}>
              再解析
            </button>
          </div>
        )}

        {usiMoves.length > 0 && (
          <ShogiBoard
            usiMoves={usiMoves}
            positions={positions}
            analyses={kifu.analyses}
            sente={kifu.sente}
            gote={kifu.gote}
          />
        )}

        <LazyDetails title="KIF">
          <pre className="text-sm font-mono whitespace-pre-wrap">
            {kifu.kifText}
          </pre>
        </LazyDetails>

        {kifu.analyses.length > 0 && (
          <>
            <LazyDetails title="局面評価値">
              <PositionEvalTable
                analyses={kifu.analyses}
                usiMoves={usiMoves}
                positions={positions}
              />
            </LazyDetails>

            <LazyDetails title="LLM 解説用テキスト">
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
            </LazyDetails>
          </>
        )}

        <LazyDetails title="メモ">
          <KifuMemo kifuId={kifu.id} memo={kifu.memo} />
        </LazyDetails>
      </div>
    </div>
  );
}

/**
 * 全局面の評価値・最善手を並べた表。
 * 局面数ぶんの行と日本語変換を伴うため、折り畳みを開くまでマウントされない
 * （`LazyDetails`）。
 */
function PositionEvalTable({
  analyses,
  usiMoves,
  positions,
}: {
  analyses: Analysis[];
  usiMoves: string[];
  positions: BoardState[];
}) {
  const blunders = detectBlunders(analyses, usiMoves);

  // USI 手を駒名付き日本語に変換（盤面がなければフォールバック）
  const toJapanese = (usi: string, state?: BoardState) =>
    state ? usiToJapaneseWithPiece(state, usi) : usi;

  return (
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
          {analyses.map((a) => {
            const best = a.candidates.find((c) => c.rank === 1);
            const turn = turnSymbol(a.moveNumber);
            const state = positions[a.moveNumber];
            const played = usiMoves[a.moveNumber];
            const isBestMove = best && played && best.move === played;
            return (
              <tr key={a.id}>
                <td>{a.moveNumber}</td>
                <td>
                  {played ? `${turn}${toJapanese(played, state)}` : '-'}
                </td>
                <td>
                  {best
                    ? formatScore(best.scoreType, best.scoreValue, a.moveNumber)
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
  );
}
