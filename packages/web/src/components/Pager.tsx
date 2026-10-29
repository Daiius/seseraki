/** ページ送りの位置（server の一覧の `pagination`） */
export interface Pagination {
  page: number;
  totalPages: number;
}

/** ページ送り（棋譜一覧・出題の一覧）。**1 ページに収まるときは出さない** */
export function Pager({
  pagination,
  onPage,
}: {
  pagination: Pagination;
  onPage: (page: number) => void;
}) {
  if (pagination.totalPages <= 1) return null;
  const { page, totalPages } = pagination;
  return (
    <div className="join mt-4 flex justify-center">
      <button className="join-item btn" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        «
      </button>
      <button className="join-item btn">
        {page} / {totalPages}
      </button>
      <button
        className="join-item btn"
        disabled={page >= totalPages}
        onClick={() => onPage(page + 1)}
      >
        »
      </button>
    </div>
  );
}
