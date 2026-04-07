import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { client } from '../lib/honoClient';

export const Route = createFileRoute('/')({
  validateSearch: (search: Record<string, unknown>): { page?: number } => ({
    page: Number(search.page) || undefined,
  }),
  loaderDeps: ({ search }) => ({ page: search.page ?? 1 }),
  loader: async ({ deps: { page } }) => {
    try {
      const res = await client.kifus.$get({ query: { page } });
      if (!res.ok) return { kifus: [], pagination: null, error: `サーバーエラー (${res.status})` };
      const data = await res.json();
      return { kifus: data.kifus, pagination: data.pagination, error: null };
    } catch {
      return { kifus: [], pagination: null, error: 'サーバーに接続できません' };
    }
  },
  component: KifuListPage,
});

function KifuListPage() {
  const { kifus, pagination, error } = Route.useLoaderData();
  const { page = 1 } = Route.useSearch();
  const navigate = useNavigate();

  const goToPage = (p: number) => navigate({ to: '/', search: { page: p } });

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
        <>
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>タイトル</th>
                  <th>解析</th>
                  <th>対局日時</th>
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
                    <td>
                      {kifu.playedAt
                        ? new Date(kifu.playedAt).toLocaleString('ja-JP')
                        : new Date(kifu.createdAt).toLocaleString('ja-JP')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pagination && pagination.totalPages > 1 && (
            <div className="join mt-4 flex justify-center">
              <button
                className="join-item btn"
                disabled={page <= 1}
                onClick={() => goToPage(page - 1)}
              >
                «
              </button>
              <button className="join-item btn">
                {page} / {pagination.totalPages}
              </button>
              <button
                className="join-item btn"
                disabled={page >= pagination.totalPages}
                onClick={() => goToPage(page + 1)}
              >
                »
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
