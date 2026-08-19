import { createFileRoute, Link } from '@tanstack/react-router';
import { client } from '../lib/honoClient';
import { TacticTags } from '../components/TacticTags';

/**
 * 動画解析（prd/10 §6.1）。録画から復元した棋譜を**動画ごと → 局ごと**に並べる。
 *
 * ⚠ **自分の対局とは別のページにする**（prd/10 §2.2）。勝敗も対局者も無いので、
 * 一覧・分析に混ぜても意味のある数字にならない。棋譜ビューア（`/kifus/$id`）は共用する。
 */
async function loadVideoGames() {
  try {
    const res = await client.api['video-analysis'].kifus.$get();
    if (!res.ok) return { games: null, error: `サーバーエラー (${res.status})` };
    const { games } = await res.json();
    return { games, error: null };
  } catch {
    return { games: null, error: 'サーバーに接続できません' };
  }
}

export const Route = createFileRoute('/video-analysis')({
  loader: loadVideoGames,
  component: VideoAnalysisPage,
});

/** 秒を動画の再生位置（`m:ss`）にする。区間の長さが分かればよいので時間は繰り上げない */
function clock(sec: number): string {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

// 行の型は **API の戻りから導く**（手書きすると server と静かに乖離する）
type Game = NonNullable<Awaited<ReturnType<typeof loadVideoGames>>['games']>[number];

/** 動画ごとにまとめる。server が videoId → gameIndex の順で返すので、並びはそのまま使える */
function groupByVideo(games: Game[]): { videoId: string; games: Game[] }[] {
  const groups: { videoId: string; games: Game[] }[] = [];
  for (const game of games) {
    const last = groups.at(-1);
    if (last?.videoId === game.videoId) last.games.push(game);
    else groups.push({ videoId: game.videoId, games: [game] });
  }
  return groups;
}

function StatusBadge({ game }: { game: Game }) {
  // ⚠ バッジは折り返させない（「未解 / 析」と割れる）
  const cls = 'badge badge-sm whitespace-nowrap';
  if (game.failed) {
    return (
      <span className={`${cls} badge-error`} title={game.analysisError ?? ''}>
        解析失敗
      </span>
    );
  }
  if (game.analyzed) return <span className={`${cls} badge-success`}>解析済</span>;
  return <span className={`${cls} badge-ghost`}>未解析</span>;
}

function VideoAnalysisPage() {
  const { games, error } = Route.useLoaderData();

  if (error) {
    return (
      <div className="container mx-auto p-4">
        <div className="alert alert-error">{error}</div>
      </div>
    );
  }

  const groups = groupByVideo(games ?? []);

  return (
    <div className="container mx-auto p-4">
      <h1 className="text-2xl font-bold mb-2">動画解析</h1>
      <p className="text-sm opacity-70 mb-6">
        録画から盤面の変化を読み取って復元した棋譜。
        <strong>自分の対局ではない</strong>ため、棋譜一覧と分析ページには出ない。
      </p>

      {groups.length === 0 && (
        <div className="alert">
          まだ取り込まれていない（復元側の import で投入する）。
        </div>
      )}

      {groups.map((group) => (
        <section key={group.videoId} className="mb-8">
          <h2 className="text-lg font-semibold mb-3 flex items-baseline gap-2">
            <span className="font-mono">{group.videoId}</span>
            <span className="text-sm font-normal opacity-60">
              {group.games.length} 局
            </span>
          </h2>

          <div className="overflow-x-auto">
            <table className="table table-zebra">
              <thead>
                <tr>
                  <th>局</th>
                  <th>区間</th>
                  <th className="text-right">手数</th>
                  <th>録画者</th>
                  {/* 戦型に余りを吸わせる。そうしないとタグの多い行が他の列を圧迫し、
                      「未解析」が「未解 / 析」と割れる */}
                  <th className="w-full">戦型</th>
                  <th>解析</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {group.games.map((game) => (
                  <tr key={game.kifuId}>
                    <td className="whitespace-nowrap">第 {game.gameIndex} 局</td>
                    <td className="whitespace-nowrap font-mono text-sm">
                      {clock(game.startedAtSec)}〜{clock(game.endedAtSec)}
                    </td>
                    <td className="text-right">{game.moveCount}</td>
                    {/* 画面の下が録画者。動画解析に「自分」はいないので、先後だけを示す */}
                    <td className="whitespace-nowrap">
                      {game.bottomIsSente ? '▲先手' : '△後手'}
                    </td>
                    <td className="w-full">
                      <TacticTags tactics={game.tactics} userSide={null} />
                    </td>
                    <td className="whitespace-nowrap">
                      <StatusBadge game={game} />
                    </td>
                    <td className="whitespace-nowrap">
                      <Link
                        to="/kifus/$id"
                        params={{ id: String(game.kifuId) }}
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

          <p className="text-xs opacity-50 mt-2">
            復元器: <span className="font-mono">{group.games[0].extractorRev}</span>
          </p>
        </section>
      ))}
    </div>
  );
}
