import { createFileRoute, Link } from '@tanstack/react-router';
import { client } from '../lib/honoClient';

export const Route = createFileRoute('/')({
  loader: async () => {
    const res = await client.kifus.$get();
    if (!res.ok) throw new Error('Failed to fetch kifus');
    return await res.json();
  },
  component: KifuListPage,
});

function KifuListPage() {
  const kifus = Route.useLoaderData();

  return (
    <div>
      <h2 className="text-2xl font-bold mb-4">棋譜一覧</h2>
      {kifus.length === 0 ? (
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
