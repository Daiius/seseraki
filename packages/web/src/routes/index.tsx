import { createFileRoute, Link } from '@tanstack/react-router';
import { client } from '../lib/honoClient';

export const Route = createFileRoute('/')({
  loader: async () => {
    try {
      const res = await client.kifus.$get();
      if (!res.ok) return { kifus: [], error: `サーバーエラー (${res.status})` };
      return { kifus: await res.json(), error: null };
    } catch {
      return { kifus: [], error: 'サーバーに接続できません' };
    }
  },
  component: KifuListPage,
});

function KifuListPage() {
  const { kifus, error } = Route.useLoaderData();

  return (
    <div>
      <h2 className="text-2xl font-bold mb-4">棋譜一覧</h2>
      {error && (
        <div className="alert alert-warning mb-4">{error}</div>
      )}
      {kifus.length === 0 && !error ? (
        <p className="text-base-content/60">
          棋譜がまだありません。
          <Link to="/kifus/new" className="link link-primary">
            登録する
          </Link>
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>ID</th>
                <th>タイトル</th>
                <th>解析</th>
                <th>登録日時</th>
              </tr>
            </thead>
            <tbody>
              {kifus.map((kifu) => (
                <tr key={kifu.id} className="hover">
                  <td>{kifu.id}</td>
                  <td>
                    <Link
                      to="/kifus/$id"
                      params={{ id: String(kifu.id) }}
                      className="link"
                    >
                      {kifu.title}
                    </Link>
                  </td>
                  <td>
                    {'analyzed' in kifu && (
                      <span
                        className={
                          kifu.analyzed
                            ? 'badge badge-success badge-sm'
                            : 'badge badge-ghost badge-sm'
                        }
                      >
                        {kifu.analyzed ? '済' : '未'}
                      </span>
                    )}
                  </td>
                  <td>{new Date(kifu.createdAt).toLocaleString('ja-JP')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
