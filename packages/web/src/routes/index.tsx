import { useEffect, useState } from 'react';
import { createFileRoute, Link, useNavigate, useRouter } from '@tanstack/react-router';
import useSWR from 'swr';
import { client } from '../lib/honoClient';
import { getSelfNames, resolveUserSide } from '../lib/self';

type JobStatus =
  | { status: 'idle' }
  | { status: 'running'; startedAt: string }
  | {
      status: 'done';
      startedAt: string;
      finishedAt: string;
      imported: { id: number; gameKey: string }[];
      skipped: string[];
      errors: { gameKey: string; error: string }[];
    }
  | {
      status: 'error';
      startedAt: string;
      finishedAt: string;
      errorKind: 'cookie_expired' | 'generic';
      errorMessage: string;
    };

// server 側の zod スキーマ（`POST /api/swars/import` の `pages: 1..10`）と揃える
const MAX_IMPORT_PAGES = 10;

// 一覧の絞り込み・並べ替え。値は server 側の zod スキーマ（`GET /api/kifus`）と揃える
const STATUSES = ['all', 'analyzed', 'unanalyzed', 'failed'] as const;
const OUTCOMES = ['all', 'win', 'loss'] as const;
const SORTS = ['playedAt', 'createdAt', 'title'] as const;
const ORDERS = ['asc', 'desc'] as const;

type Status = (typeof STATUSES)[number];
type Outcome = (typeof OUTCOMES)[number];
type Sort = (typeof SORTS)[number];
type Order = (typeof ORDERS)[number];

// 生成される routeTree が `IndexRoute` の型でこれを参照するため export が要る
export interface KifuListSearch {
  page?: number;
  q?: string;
  status?: Status;
  outcome?: Outcome;
  from?: string;
  to?: string;
  sort?: Sort;
  order?: Order;
}

/** 許可値でなければ既定に落とす。既定値は `undefined` にして URL に載せない */
function option<T extends string>(
  values: readonly T[],
  raw: unknown,
  fallback: T,
): T | undefined {
  const value = values.find((v) => v === raw);
  return value && value !== fallback ? value : undefined;
}

/** `<input type="date">` が返す `YYYY-MM-DD` だけを受ける */
function dateParam(raw: unknown): string | undefined {
  return typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : undefined;
}

const jobStatusFetcher = async (): Promise<JobStatus> => {
  const res = await client.api.swars.import.status.$get();
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()) as JobStatus;
};

export const Route = createFileRoute('/')({
  validateSearch: (search: Record<string, unknown>): KifuListSearch => ({
    page: Number(search.page) || undefined,
    // 検索語は trim しない（入力中の末尾スペースが打鍵のたびに消えてしまうため）。
    // 前後の空白は server 側の zod が落とす
    q: typeof search.q === 'string' && search.q !== '' ? search.q : undefined,
    status: option(STATUSES, search.status, 'all'),
    outcome: option(OUTCOMES, search.outcome, 'all'),
    from: dateParam(search.from),
    to: dateParam(search.to),
    sort: option(SORTS, search.sort, 'playedAt'),
    order: option(ORDERS, search.order, 'desc'),
  }),
  loaderDeps: ({ search }) => ({
    page: search.page ?? 1,
    q: search.q,
    status: search.status ?? 'all',
    outcome: search.outcome ?? 'all',
    from: search.from,
    to: search.to,
    sort: search.sort ?? 'playedAt',
    order: search.order ?? 'desc',
  }),
  loader: async ({ deps }) => {
    try {
      const res = await client.api.kifus.$get({
        query: {
          ...deps,
          // 勝敗で絞るときだけ自分の名前候補を渡す。server は「自分」を知らないため
          // 判定材料をここから供給する（VITE_SELF_NAMES ∪ VITE_SWARS_USER_ID が単一の正）
          self: deps.outcome === 'all' ? undefined : getSelfNames().join(','),
        },
      });
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
  const {
    page = 1,
    q = '',
    status = 'all',
    outcome = 'all',
    from,
    to,
    sort = 'playedAt',
    order = 'desc',
  } = Route.useSearch();
  const navigate = useNavigate();
  const router = useRouter();
  const [isPolling, setIsPolling] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);
  const [jobStartedAt, setJobStartedAt] = useState<string | null>(null);
  // 遡って取得する対局履歴のページ数。常用は 1 ページなので既定に戻す（永続化しない）
  const [importPages, setImportPages] = useState(1);
  // 検索語は打鍵ごとに URL を書き換えず、入力欄のドラフトを debounce して反映する
  const [queryDraft, setQueryDraft] = useState(q);

  // 戻る/進む・「条件をクリア」など URL 側が変わったときは入力欄を追従させる
  useEffect(() => {
    setQueryDraft(q);
  }, [q]);

  useEffect(() => {
    if (queryDraft === q) return;
    const timer = setTimeout(() => {
      navigate({
        to: '/',
        search: (prev: KifuListSearch) => ({
          ...prev,
          q: queryDraft || undefined,
          page: undefined,
        }),
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [queryDraft, q, navigate]);

  const goToPage = (p: number) =>
    navigate({
      to: '/',
      search: (prev: KifuListSearch) => ({ ...prev, page: p > 1 ? p : undefined }),
    });

  // 絞り込みを変えたらページは 1 に戻す（前のページ番号のまま 0 件になるのを防ぐ）
  const updateFilter = (patch: KifuListSearch) =>
    navigate({
      to: '/',
      search: (prev: KifuListSearch) => ({ ...prev, ...patch, page: undefined }),
    });

  const clearFilters = () => navigate({ to: '/', search: {} });

  // 並べ替えは絞り込みではないので、件数が変わらない＝空表示の文言には影響しない
  const filtered = Boolean(q || status !== 'all' || outcome !== 'all' || from || to);
  const canFilterByOutcome = getSelfNames().length > 0;

  const { data: jobStatus } = useSWR<JobStatus>(
    isPolling ? 'swars-import-status' : null,
    jobStatusFetcher,
    {
      refreshInterval: 3000,
      errorRetryCount: 3,
      revalidateOnFocus: false,
      dedupingInterval: 0,
    },
  );

  useEffect(() => {
    if (!jobStatus) return;
    // POST レスポンス確定前、または startedAt が今回のジョブと一致しない
    // 残留状態（前回の done/error 等）は UI に反映しない
    if (!jobStartedAt) return;
    if (!('startedAt' in jobStatus) || jobStatus.startedAt !== jobStartedAt) return;
    if (jobStatus.status === 'done') {
      const count = jobStatus.imported.length;
      setImportResult(
        count > 0 ? `${count}件の棋譜を取得しました` : '新しい棋譜はありません',
      );
      setIsPolling(false);
      setJobStartedAt(null);
      if (count > 0) router.invalidate();
    } else if (jobStatus.status === 'error') {
      setImportResult(
        jobStatus.errorKind === 'cookie_expired'
          ? 'SWARS_SESSION_COOKIE が期限切れです。再設定してください'
          : `取得失敗: ${jobStatus.errorMessage}`,
      );
      setIsPolling(false);
      setJobStartedAt(null);
    }
  }, [jobStatus, router, jobStartedAt]);

  const handleImport = async () => {
    const userId = import.meta.env.VITE_SWARS_USER_ID;
    if (!userId) return;

    setImportResult(null);
    setIsPolling(true);
    try {
      const res = await client.api.swars.import.$post({
        json: { userId, pages: importPages },
      });
      if (!res.ok) {
        setImportResult(`取得失敗 (${res.status})`);
        setIsPolling(false);
        return;
      }
      const state = (await res.json()) as JobStatus;
      if (state.status === 'running') {
        setJobStartedAt(state.startedAt);
      } else {
        setIsPolling(false);
      }
    } catch {
      setImportResult('サーバーに接続できません');
      setIsPolling(false);
    }
  };

  const importing = isPolling;

  return (
    <div>
      <div className="flex items-center gap-4 mb-4">
        <h2 className="text-2xl font-bold">棋譜一覧</h2>
        {import.meta.env.VITE_SWARS_USER_ID ? (
          <div className="join">
            <select
              className="join-item select select-sm select-bordered"
              value={importPages}
              disabled={importing}
              onChange={(e) => setImportPages(Number(e.target.value))}
              aria-label="取得ページ数"
              title="遡って取得する対局履歴のページ数（取り込み済みの対局はスキップされる）"
            >
              {Array.from({ length: MAX_IMPORT_PAGES }, (_, i) => i + 1).map((p) => (
                <option key={p} value={p}>
                  {p}ページ
                </option>
              ))}
            </select>
            <button
              className="join-item btn btn-sm btn-outline"
              disabled={importing}
              onClick={handleImport}
            >
              {importing ? <span className="loading loading-spinner loading-xs" /> : '更新'}
            </button>
          </div>
        ) : (
          <span className="text-xs text-base-content/50">
            VITE_SWARS_USER_ID が未設定のため更新ボタンを表示できません
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <input
          type="search"
          className="input input-sm input-bordered w-56"
          placeholder="タイトル・対局者名で検索"
          value={queryDraft}
          onChange={(e) => setQueryDraft(e.target.value)}
          aria-label="タイトル・対局者名で検索"
        />
        <select
          className="select select-sm select-bordered"
          value={status}
          onChange={(e) => updateFilter({ status: e.target.value as Status })}
          aria-label="解析状態で絞り込み"
        >
          <option value="all">状態: すべて</option>
          <option value="analyzed">解析済み</option>
          <option value="unanalyzed">未解析</option>
          <option value="failed">解析失敗</option>
        </select>
        {canFilterByOutcome && (
          <select
            className="select select-sm select-bordered"
            value={outcome}
            onChange={(e) => updateFilter({ outcome: e.target.value as Outcome })}
            aria-label="勝敗で絞り込み"
          >
            <option value="all">勝敗: すべて</option>
            <option value="win">勝ち</option>
            <option value="loss">負け</option>
          </select>
        )}
        <div className="flex items-center gap-1">
          <input
            type="date"
            className="input input-sm input-bordered"
            value={from ?? ''}
            max={to}
            onChange={(e) => updateFilter({ from: e.target.value || undefined })}
            aria-label="期間の開始日"
          />
          <span className="text-base-content/60">〜</span>
          <input
            type="date"
            className="input input-sm input-bordered"
            value={to ?? ''}
            min={from}
            onChange={(e) => updateFilter({ to: e.target.value || undefined })}
            aria-label="期間の終了日"
          />
        </div>
        <div className="join">
          <select
            className="join-item select select-sm select-bordered"
            value={sort}
            onChange={(e) => updateFilter({ sort: e.target.value as Sort })}
            aria-label="並べ替えの基準"
          >
            <option value="playedAt">対局日時順</option>
            <option value="createdAt">登録日時順</option>
            <option value="title">タイトル順</option>
          </select>
          <button
            className="join-item btn btn-sm btn-outline"
            onClick={() => updateFilter({ order: order === 'desc' ? 'asc' : 'desc' })}
            title={order === 'desc' ? '降順（新しい順）' : '昇順（古い順）'}
            aria-label="並び順を切り替え"
          >
            {order === 'desc' ? '↓' : '↑'}
          </button>
        </div>
        {(filtered || sort !== 'playedAt' || order !== 'desc') && (
          <button className="btn btn-sm btn-ghost" onClick={clearFilters}>
            条件をクリア
          </button>
        )}
        {pagination && (
          <span className="text-sm text-base-content/60">{pagination.total}件</span>
        )}
      </div>
      {importResult && (
        <div className="alert alert-info mb-4">{importResult}</div>
      )}
      {error && (
        <div className="alert alert-warning mb-4">{error}</div>
      )}
      {kifus.length === 0 && !error ? (
        filtered ? (
          <p className="text-base-content/60">
            条件に一致する棋譜がありません。
            <button className="link link-primary" onClick={clearFilters}>
              条件をクリア
            </button>
          </p>
        ) : (
          <p className="text-base-content/60">
            棋譜がまだありません。
            <Link to="/kifus/new" className="link link-primary">
              登録する
            </Link>
          </p>
        )
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>タイトル</th>
                  <th>状態</th>
                  <th>対局日時</th>
                </tr>
              </thead>
              <tbody>
                {kifus.map((kifu) => {
                  const r = kifu.result;
                  const { side: userSide } = resolveUserSide(kifu.sente, kifu.gote);
                  const isSente = userSide === 'sente';
                  const isGote = userSide === 'gote';
                  const won = !!r && ((isSente && r.includes('SENTE_WIN')) || (isGote && r.includes('GOTE_WIN')));
                  const lost = !!r && ((isSente && r.includes('GOTE_WIN')) || (isGote && r.includes('SENTE_WIN')));
                  const showResultBadge = isSente || isGote;
                  return (
                    <tr key={kifu.id} className="hover">
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
                        <div className="flex gap-1 items-center">
                          {showResultBadge && (
                            won ? <span className="badge badge-soft badge-success badge-sm">勝</span>
                            : lost ? <span className="badge badge-soft badge-error badge-sm">負</span>
                            : <span className="badge badge-ghost badge-sm">−</span>
                          )}
                          {'failed' in kifu && kifu.failed ? (
                            <span className="badge badge-error badge-sm">失敗</span>
                          ) : (
                            'analyzed' in kifu && (
                              <span
                                className={
                                  kifu.analyzed
                                    ? 'badge badge-success badge-sm'
                                    : 'badge badge-ghost badge-sm'
                                }
                              >
                                {kifu.analyzed ? '済' : '未'}
                              </span>
                            )
                          )}
                          {kifu.hasMemo && (
                            <span className="badge badge-sm bg-info/50 text-info-content">
                              ●
                            </span>
                          )}
                        </div>
                      </td>
                      <td>
                        {kifu.playedAt ? (
                          new Date(kifu.playedAt).toLocaleString('ja-JP')
                        ) : (
                          // 対局日時が取れなかった棋譜は登録日時で代替表示・並び替えされる
                          // （`coalesce(playedAt, createdAt)` 降順）。どちらの日時かを明示する
                          <span
                            className="text-base-content/60"
                            title="対局日時が取得できなかったため、登録日時を表示しています"
                          >
                            {new Date(kifu.createdAt).toLocaleString('ja-JP')}
                            <span className="ml-1 text-xs">（登録）</span>
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
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
