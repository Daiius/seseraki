import { useState } from 'react';
import { createFileRoute, Link, useNavigate, useRouter } from '@tanstack/react-router';
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
  const router = useRouter();
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);

  const goToPage = (p: number) => navigate({ to: '/', search: { page: p } });

  const handleImport = async () => {
    const userId = import.meta.env.VITE_SWARS_USER_ID;
    const apiKey = import.meta.env.VITE_CLIENT_API_KEY;
    if (!userId || !apiKey) return;

    setImporting(true);
    setImportResult(null);
    try {
      const res = await client.swars.import.$post(
        { json: { userId, pages: 1 } },
        { headers: { Authorization: `Bearer ${apiKey}` } },
      );
      if (!res.ok) {
        setImportResult(`取得失敗 (${res.status})`);
        return;
      }
      const data = await res.json();
      const count = data.imported.length;
      setImportResult(
        count > 0 ? `${count}件の棋譜を取得しました` : '新しい棋譜はありません',
      );
      if (count > 0) router.invalidate();
    } catch {
      setImportResult('サーバーに接続できません');
    } finally {
      setImporting(false);
    }
  };

  return (
    <div>
      <div className="flex items-center gap-4 mb-4">
        <h2 className="text-2xl font-bold">棋譜一覧</h2>
        {import.meta.env.VITE_SWARS_USER_ID ? (
          <button
            className="btn btn-sm btn-outline"
            disabled={importing}
            onClick={handleImport}
          >
            {importing ? <span className="loading loading-spinner loading-xs" /> : '更新'}
          </button>
        ) : (
          <span className="text-xs text-base-content/50">
            VITE_SWARS_USER_ID が未設定のため更新ボタンを表示できません
          </span>
        )}
      </div>
      {importResult && (
        <div className="alert alert-info mb-4">{importResult}</div>
      )}
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
