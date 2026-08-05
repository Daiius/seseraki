import { useEffect, useState } from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { client } from '../lib/honoClient';
import {
  DEFAULT_ORDER,
  DEFAULT_SORT,
  DEFAULT_TACTIC_SIDE,
  describeFilters,
  isFiltered,
  ORDERS,
  OUTCOMES,
  SORTS,
  STATUSES,
  TACTIC_OPTIONS,
  TACTIC_SIDES,
  tacticSideApplies,
  type Order,
  type Outcome,
  type Sort,
  type Status,
  type TacticSide,
} from '../lib/kifuListFilter';
import { useAnalysisProgress } from '../lib/useAnalysisProgress';
import { getSelfNames, resolveUserSide } from '../lib/self';
import { AnalyzingRadial } from '../components/AnalyzingRadial';
import { TacticTags, TacticLegend, legendModeOf } from '../components/TacticTags';

// 一覧の絞り込み・並べ替えの許可値と条件の要約は `lib/kifuListFilter.ts`（単体テスト付き）。
// server 側の `q: z.string().trim().max(100)` と揃える。超える値を送ると一覧全体が 400 になるため、
// 入力欄の maxLength と URL 直入力の正規化の両方で頭打ちにする
const MAX_SEARCH_LENGTH = 100;

// 生成される routeTree が `IndexRoute` の型でこれを参照するため export が要る
export interface KifuListSearch {
  page?: number;
  q?: string;
  status?: Status;
  outcome?: Outcome;
  tactic?: string;
  tacticSide?: TacticSide;
  /** 分析ページからの導線（prd/09 §7）。専用の入力 UI は持たず URL から受けるだけ */
  missedMate?: number;
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

/** 判定が返しうるラベルだけを受ける（URL 直入力の未知の値は無視して全件に戻す） */
function tacticParam(raw: unknown): string | undefined {
  return typeof raw === 'string' && TACTIC_OPTIONS.includes(raw) ? raw : undefined;
}

/** 詰み手数の上限。1 以上の整数だけ受ける（server の zod と揃える） */
function missedMateParam(raw: unknown): number | undefined {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : undefined;
}

/** `<input type="date">` が返す `YYYY-MM-DD` だけを受ける */
function dateParam(raw: unknown): string | undefined {
  return typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : undefined;
}

export const Route = createFileRoute('/')({
  validateSearch: (search: Record<string, unknown>): KifuListSearch => ({
    page: Number(search.page) || undefined,
    // 検索語は trim しない（入力中の末尾スペースが打鍵のたびに消えてしまうため）。
    // 前後の空白は server 側の zod が落とす。長すぎる URL 直入力は捨てずに切り詰める
    // （拒否して一覧全体をエラーにするより、頭 100 字で検索した方が扱いやすい）
    q:
      typeof search.q === 'string' && search.q !== ''
        ? search.q.slice(0, MAX_SEARCH_LENGTH)
        : undefined,
    status: option(STATUSES, search.status, 'all'),
    outcome: option(OUTCOMES, search.outcome, 'all'),
    tactic: tacticParam(search.tactic),
    tacticSide: option(TACTIC_SIDES, search.tacticSide, DEFAULT_TACTIC_SIDE),
    missedMate: missedMateParam(search.missedMate),
    from: dateParam(search.from),
    to: dateParam(search.to),
    sort: option(SORTS, search.sort, DEFAULT_SORT),
    order: option(ORDERS, search.order, DEFAULT_ORDER),
  }),
  loaderDeps: ({ search }) => ({
    page: search.page ?? 1,
    q: search.q,
    status: search.status ?? 'all',
    outcome: search.outcome ?? 'all',
    tactic: search.tactic,
    tacticSide: search.tacticSide ?? DEFAULT_TACTIC_SIDE,
    missedMate: search.missedMate,
    from: search.from,
    to: search.to,
    sort: search.sort ?? DEFAULT_SORT,
    order: search.order ?? DEFAULT_ORDER,
  }),
  loader: async ({ deps }) => {
    // server は「自分」を知らないので、自分の側に依存する絞り込みでは名前候補を渡す
    // （VITE_SELF_NAMES ∪ VITE_SWARS_USER_ID が単一の正）。
    // 取りこぼしは**負け条件を内包する**ので、それだけでも自分の側が要る（prd/09 §3.1）
    const needsSelf =
      deps.outcome !== 'all' ||
      deps.missedMate !== undefined ||
      (deps.tactic !== undefined && deps.tacticSide !== 'any');
    try {
      const res = await client.api.kifus.$get({
        query: {
          ...deps,
          self: needsSelf ? getSelfNames().join(',') : undefined,
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
    tactic,
    tacticSide = DEFAULT_TACTIC_SIDE,
    missedMate,
    from,
    to,
    sort = DEFAULT_SORT,
    order = DEFAULT_ORDER,
  } = Route.useSearch();
  const navigate = useNavigate();
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

  const clearFilters = () => {
    // ドラフトも同時に空へ戻す。debounce 待機中にクリアすると、URL の `q` が元から未指定なら
    // 上の同期 effect が発火せず、保留中のタイマーがクリア後に検索語を書き戻してしまう
    setQueryDraft('');
    navigate({ to: '/', search: {} });
  };

  // 並べ替えは絞り込みではないので、件数が変わらない＝空表示の文言には影響しない
  // 解析中の棋譜は高々 1 件。一覧のバッジを「未」から「解析中 N/M」に差し替えるために使う。
  // 進捗はメモリにあり SQL で絞り込めないため、状態フィルタには「解析中」を足さない
  // （絞り込み・件数・ページングを server 側の SQL に揃える方針を崩さない。prd/04 §6.1）
  const { progress } = useAnalysisProgress();

  const filtered = isFiltered({ q, status, outcome, tactic, missedMate, from, to });
  // 畳んだままでも「なぜ件数が少ないのか」が読めるように、効いている条件を summary に出す
  const filterSummary = describeFilters({
    q,
    status,
    outcome,
    tactic,
    tacticSide,
    missedMate,
    from,
    to,
    sort,
    order,
  });
  const canFilterByOutcome = getSelfNames().length > 0;
  // 側で絞れるのは手番固有のラベルだけ（角換わり・相掛かりは server も side を見ない）。
  // 自分の名前候補が無いときも自分/相手は決まらない
  const canFilterByTacticSide = tacticSideApplies(tactic) && canFilterByOutcome;

  // 見出しの凡例は**このページで実際に使われている色分け**から組む。
  // どの行が根拠になるか（手番固有のタグが表示に残るか）は `legendModeOf` が決める。
  const legendModes = kifus
    .map((k) => legendModeOf(k.tactics, resolveUserSide(k.sente, k.gote).side))
    .reduce(
      (acc, mode) => (mode === null ? acc : { ...acc, [mode]: true }),
      { self: false, unresolved: false },
    );

  return (
    <div>
      <div className="flex items-center gap-4 mb-4">
        <h2 className="text-2xl font-bold">棋譜一覧</h2>
      </div>
      {/*
        フィルタバーは既定で畳む（暫定・#50）。現状の絞り込み軸だけでは常時出しておくほど使わず、
        一覧の上部を占有するため。畳んだままでも条件が読めるよう summary に要約を出し、自動では開かない。
        中身が軽く開閉のたびに入力状態を作り直したくないので、LazyDetails ではなく素の <details> を使う。
      */}
      <details className="collapse collapse-arrow bg-base-200 mb-2">
        <summary className="collapse-title py-2 text-sm font-semibold">
          <span className="flex items-baseline gap-2">
            <span className="shrink-0">検索</span>
            {filterSummary && (
              <span className="truncate font-normal text-base-content/70">{filterSummary}</span>
            )}
          </span>
        </summary>
        <div className="collapse-content">
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="search"
              className="input input-sm input-bordered w-56"
              placeholder="タイトル・対局者名で検索"
              value={queryDraft}
              maxLength={MAX_SEARCH_LENGTH}
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
            <div className="join">
              {/* 選択肢は shared の語彙から出す（判定にラベルが増えたら自動で増える。prd/09 §6.1） */}
              <select
                className="join-item select select-sm select-bordered"
                value={tactic ?? ''}
                onChange={(e) => {
                  const next = e.target.value || undefined;
                  // 側で絞れないラベルへ切り替えたら側の指定も落とす
                  // （効かない条件が URL に残り続けるのを防ぐ）
                  updateFilter({
                    tactic: next,
                    tacticSide: tacticSideApplies(next) ? tacticSide : undefined,
                  });
                }}
                aria-label="戦型で絞り込み"
              >
                <option value="">戦型: すべて</option>
                {TACTIC_OPTIONS.map((label) => (
                  <option key={label} value={label}>
                    {label}
                  </option>
                ))}
              </select>
              {/* ⚠ 角換わり・相掛かりでは無効化する。`side` の意味が違うので側で絞れない */}
              <select
                className="join-item select select-sm select-bordered"
                // 効いていない指定を表示しない（絞れないラベルでは server も side を見ない）
                value={canFilterByTacticSide ? tacticSide : DEFAULT_TACTIC_SIDE}
                disabled={!canFilterByTacticSide}
                onChange={(e) => updateFilter({ tacticSide: e.target.value as TacticSide })}
                aria-label="戦型をどちらの側で絞るか"
                title={
                  tactic && !tacticSideApplies(tactic)
                    ? `${tactic}は双方の戦型なので側では絞れません`
                    : undefined
                }
              >
                <option value="any">問わない</option>
                <option value="self">自分</option>
                <option value="opponent">相手</option>
              </select>
            </div>
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
            {(filtered || sort !== DEFAULT_SORT || order !== DEFAULT_ORDER) && (
              <button className="btn btn-sm btn-ghost" onClick={clearFilters}>
                条件をクリア
              </button>
            )}
          </div>
        </div>
      </details>
      {/*
        取りこぼしは分析ページからの導線でしか付かない（専用の入力 UI は持たない。prd/09 §7）。
        URL でしか指定できないぶん「なぜ件数が少ないのか」が分からなくなりやすいので、
        折り畳みの外にバッジと解除リンクを出す
      */}
      {missedMate !== undefined && (
        <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
          <span className="badge badge-warning badge-sm">取りこぼしのみ表示中</span>
          <span className="text-base-content/70">
            {missedMate}手詰以下を逃して負けた対局
          </span>
          <button
            className="link link-primary"
            onClick={() => updateFilter({ missedMate: undefined })}
          >
            解除
          </button>
        </div>
      )}
      {/* 件数は折り畳みの外に出す（閉じている間も見えるように） */}
      {pagination && (
        <div className="mb-4 text-sm text-base-content/60">{pagination.total}件</div>
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
                  {/* データ側が「タイトル + 戦型タグ」の 2 行なので、見出しも 2 行にして
                      下の行にタグの色分けの凡例を置く（`TacticLegend`） */}
                  <th>
                    <div>タイトル</div>
                    {/* ⚠ 凡例は**このページに実際に出ている分け方**から組む。名前候補の設定有無で
                        決めると、自分が参加していない対局・名前の表記が違う対局・双方が候補に
                        一致する対局で ▲△ 表示になり、凡例が嘘になる（指摘 OCL-66ED0D3A） */}
                    <TacticLegend
                      self={legendModes.self}
                      unresolved={legendModes.unresolved}
                      className="mt-1"
                    />
                  </th>
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
                  const analyzing =
                    progress && progress.kifuId === kifu.id ? progress : null;
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
                        {/* 戦型タグはタイトルの下に置く。列を足すとモバイルで幅が足りない */}
                        <TacticTags
                          tactics={kifu.tactics}
                          userSide={userSide}
                          className="mt-1"
                        />
                      </td>
                      <td>
                        <div className="flex gap-1 items-center">
                          {showResultBadge && (
                            won ? <span className="badge badge-soft badge-success badge-sm">勝</span>
                            : lost ? <span className="badge badge-soft badge-error badge-sm">負</span>
                            : <span className="badge badge-ghost badge-sm">−</span>
                          )}
                          {analyzing ? (
                            <AnalyzingRadial
                              analyzed={analyzing.analyzed}
                              total={analyzing.total}
                            />
                          ) : 'failed' in kifu && kifu.failed ? (
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
