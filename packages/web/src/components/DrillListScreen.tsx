import { useState } from 'react';
import { Link, useNavigate, useRouter } from '@tanstack/react-router';
import { client } from '../lib/honoClient';
import { callApi } from '../lib/callApi';
import { option, STATUSES, type DrillRef, type DrillsSearch } from '../lib/drillSearch';
import { refParam, type loadList } from '../lib/drillApi';
import { DrillCardList } from './DrillCards';

type DrillListData = NonNullable<Awaited<ReturnType<typeof loadList>>['list']>;

/** 問題の一覧（カード。prd/13 §7.7）。絞り込みは状態・種類 */
export function DrillListScreen({
  list,
  error,
  search,
}: {
  list: DrillListData | null;
  error: string | null;
  search: DrillsSearch;
}) {
  const navigate = useNavigate({ from: '/drills' });
  const router = useRouter();
  /** 「除外を取り消す」の結果。**失敗を黙って飲まない**——押しても何も起きないと読める */
  const [actionError, setActionError] = useState<string | null>(null);

  /** 絞り込みを変えたら 1 ページ目に戻す（棋譜一覧と同じ姿勢。prd/05 §2.5） */
  function setSearch(patch: Partial<DrillsSearch>) {
    navigate({ search: (prev) => ({ ...prev, page: undefined, ...patch }) });
  }

  async function unexclude(ref: DrillRef) {
    // 🔴 **応答を確かめてから引き直す**（レビュー `OCL-63C7DD79`）。POST だけが失敗して
    // GET が成功すると、**除外されたままの一覧が普通に描き直される**
    const result = await callApi(
      client.api.drills[':kifuNo'][':moveNumber'][':kind'].unexclude.$post({ param: refParam(ref) }),
      { fallback: (status) => `除外を取り消せませんでした (${status})` },
    );
    if (!result.ok) {
      setActionError(result.error);
      return;
    }
    setActionError(null);
    await router.invalidate();
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <Link to="/drills" className="btn btn-sm btn-ghost">
          ホーム
        </Link>
        <h1 className="text-lg font-bold">問題の一覧</h1>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <select
          className="select select-sm w-auto"
          value={search.solved ?? 'all'}
          onChange={(e) => setSearch({ solved: option(STATUSES, e.target.value) })}
        >
          <option value="all">すべての状態</option>
          <option value="unanswered">未解答</option>
          <option value="wrong">間違えた</option>
          <option value="correct">正解</option>
          <option value="excluded">除外</option>
        </select>
        <div className="join">
          {(
            [
              [undefined, 'すべて'],
              ['mate', '詰将棋'],
              ['best', '次の一手'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={label}
              type="button"
              className={`btn btn-sm join-item ${search.kind === value ? 'btn-active' : ''}`}
              onClick={() => setSearch({ kind: value })}
            >
              {label}
            </button>
          ))}
        </div>
        {list && (
          <span className="text-sm text-base-content/70 ms-auto">{list.pagination.total} 問</span>
        )}
      </div>
      {error && <p className="text-error text-sm">{error}</p>}
      {actionError && <p className="text-error text-sm">{actionError}</p>}
      {list && (
        <DrillCardList
          rows={list.drills}
          pagination={list.pagination}
          search={search}
          filtered={Boolean(search.kind || search.solved)}
          onPage={(page) => navigate({ search: (prev) => ({ ...prev, page }) })}
          onClearFilters={() => navigate({ search: { view: 'list' } })}
          onUnexclude={unexclude}
        />
      )}
    </div>
  );
}
