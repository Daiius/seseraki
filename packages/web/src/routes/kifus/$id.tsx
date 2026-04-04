import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { client } from '../../lib/honoClient';

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

  const handleDelete = async () => {
    if (!confirm('この棋譜を削除しますか？')) return;
    const res = await client.kifus[':id'].$delete({
      param: { id: String(kifu.id) },
    });
    if (res.ok) navigate({ to: '/' });
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
        <div>
          <h3 className="text-lg font-semibold mb-2">KIF</h3>
          <pre className="bg-base-200 p-4 rounded-lg overflow-x-auto text-sm font-mono whitespace-pre-wrap">
            {kifu.kifText}
          </pre>
        </div>

        {kifu.analyses.length > 0 && (
          <div>
            <h3 className="text-lg font-semibold mb-2">解析結果</h3>
            <div className="overflow-x-auto">
              <table className="table table-sm">
                <thead>
                  <tr>
                    <th>手数</th>
                    <th>評価値</th>
                    <th>最善手</th>
                    <th>読み筋</th>
                  </tr>
                </thead>
                <tbody>
                  {kifu.analyses.map((a) => (
                    <tr key={a.id}>
                      <td>{a.moveNumber}</td>
                      <td
                        className={
                          a.score > 0
                            ? 'text-success'
                            : a.score < 0
                              ? 'text-error'
                              : ''
                        }
                      >
                        {a.score > 0 ? '+' : ''}
                        {a.score}
                      </td>
                      <td>{a.bestMove}</td>
                      <td className="font-mono text-xs">{a.pv}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
