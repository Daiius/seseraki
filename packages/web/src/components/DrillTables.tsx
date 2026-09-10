import { Link } from '@tanstack/react-router';

/**
 * 出題の一覧と解答履歴の表（prd/13 §7.2 / §7.3）。
 *
 * 🔴 **答えは出さない**（正解手・実戦の手・損失）。⚠ 棋譜名と手数は**未解答でも出す**
 * （決定・2026-09-10。prd/13 §5.4）——伏せるのは解く画面の規則で、一覧は解く画面ではない。
 */
export interface DrillListRow {
  id: number;
  kind: 'mate' | 'best';
  matePlies: number | null;
  moveNumber: number;
  kifuId: number;
  title: string;
  playedAt: string | null;
  kifuCreatedAt: string;
  answers: number;
  correct: number;
  excluded: boolean;
  lastAnsweredAt: string | null;
  status: 'unanswered' | 'wrong' | 'correct';
}

export interface DrillAttemptRow {
  id: number;
  drillId: number;
  kind: 'mate' | 'best';
  moveNumber: number;
  kifuId: number;
  title: string;
  playedAt: string | null;
  move: string | null;
  moveText: string | null;
  verdict: 'correct' | 'close' | 'wrong' | null;
  lossCp: number | null;
  excluded: boolean;
  createdAt: string;
  attemptNo: number | null;
}

export interface Pagination {
  page: number;
  totalPages: number;
  total: number;
}

const KIND_LABEL = { mate: '詰み', best: '次の一手' } as const;

const STATUS_BADGE = {
  unanswered: { label: '未解答', className: 'badge-ghost' },
  wrong: { label: '間違えた', className: 'badge-warning' },
  correct: { label: '正解', className: 'badge-success' },
} as const;

const VERDICT_BADGE = {
  correct: { label: '正解', className: 'badge-success' },
  close: { label: '惜しい', className: 'badge-warning' },
  wrong: { label: '不正解', className: 'badge-error' },
} as const;

function dateText(value: string | null, fallback?: string): string {
  const source = value ?? fallback ?? null;
  return source ? new Date(source).toLocaleDateString('ja-JP') : '—';
}

function timeText(value: string): string {
  return new Date(value).toLocaleString('ja-JP');
}

/** ページ送り。**1 ページに収まるときは出さない**（棋譜一覧と同じ見せ方） */
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

/** 問題の一覧（prd/13 §7.2）。行から**その問題を解きに行ける** */
export function DrillList({
  rows,
  pagination,
  kind,
  filtered,
  excludedOnly,
  onPage,
  onClearFilters,
  onUnexclude,
}: {
  rows: DrillListRow[];
  pagination: Pagination;
  kind: 'mate' | 'best' | undefined;
  /** 絞り込みが掛かっているか。**0 件の案内を出し分ける**（prd/05 §2.5 と同じ姿勢） */
  filtered: boolean;
  /**
   * 除外した問題だけを見ている状態。
   *
   * ⚠ **この表示のときは列を減らす。** 操作が 2 つ並ぶぶん横に伸び、既定の位置で
   * 「戻す」が隠れる（実測: 一覧の枠は 720px で、全列だと表は 777px になる）。
   * 全行が除外なので「除外」バッジは重複であり、最終解答も除外の判断には要らない。
   */
  excludedOnly: boolean;
  onPage: (page: number) => void;
  onClearFilters: () => void;
  onUnexclude: (id: number) => void;
}) {
  if (rows.length === 0) {
    // ⚠ **「問題がまだ無い」と「絞り込みの結果が空」を同じ文言にしない**——
    // 記録はあるのに「まだありません」と出ると、事実と違うことを言うことになる
    return filtered ? (
      <p className="text-base-content/70 p-2">
        条件に合う問題がありません。
        <button className="link link-primary" onClick={onClearFilters}>
          条件をクリア
        </button>
      </p>
    ) : (
      <p className="text-base-content/70 p-2">
        問題がまだありません。解析済みの棋譜が増えると問題が作られます。
      </p>
    );
  }
  return (
    <>
      <div className="overflow-x-auto">
        <table className="table table-sm table-zebra">
          <thead>
            <tr>
              <th>対局日</th>
              <th>棋譜</th>
              <th>手数</th>
              <th>種類</th>
              <th>状態</th>
              <th>解答</th>
              {!excludedOnly && <th>最終解答</th>}
              {/* ⚠ **操作列は内容ぶんの幅を確保する。** `w-px` + `whitespace-nowrap` で
                  min-content まで広がる（除外表示のときはボタンが 2 つ並ぶ） */}
              <th className="w-px" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const status = STATUS_BADGE[row.status];
              return (
                <tr key={row.id}>
                  <td className="whitespace-nowrap">
                    {dateText(row.playedAt, row.kifuCreatedAt)}
                  </td>
                  <td className="max-w-60 truncate">
                    <Link
                      to="/kifus/$id"
                      params={{ id: String(row.kifuId) }}
                      className="link link-hover"
                    >
                      {row.title}
                    </Link>
                  </td>
                  {/* ⚠ 棋譜詳細は手数を URL に持たない（prd/13 §7.1）ので、手数は数字だけ出す */}
                  <td className="whitespace-nowrap">{row.moveNumber + 1} 手目</td>
                  <td className="whitespace-nowrap">
                    {KIND_LABEL[row.kind]}
                    {row.kind === 'mate' && row.matePlies !== null && (
                      <span className="ml-1 text-xs text-base-content/60">
                        {row.matePlies}手
                      </span>
                    )}
                  </td>
                  {/* ⚠ **バッジを折り返させない**。折り返すと行の高さが崩れる */}
                  <td className="whitespace-nowrap">
                    <span className={`badge badge-sm whitespace-nowrap ${status.className}`}>
                      {status.label}
                    </span>
                    {row.excluded && !excludedOnly && (
                      <span className="badge badge-sm badge-outline whitespace-nowrap ml-1">
                        除外
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap">
                    {row.answers === 0 ? '—' : `${row.correct} / ${row.answers}`}
                  </td>
                  {!excludedOnly && (
                    <td className="whitespace-nowrap">
                      {row.lastAnsweredAt ? timeText(row.lastAnsweredAt) : '—'}
                    </td>
                  )}
                  <td className="w-px whitespace-nowrap">
                    <div className="flex gap-1 justify-end">
                      <Link
                        to="/drills"
                        search={{ kind, drill: row.id }}
                        className="btn btn-xs btn-primary"
                      >
                        解く
                      </Link>
                      {/* 除外の取り消し（prd/13 §7.2）。外した理由を後から見直せるようにする */}
                      {row.excluded && (
                        <button
                          type="button"
                          className="btn btn-xs btn-ghost"
                          title="除外を戻す"
                          onClick={() => onUnexclude(row.id)}
                        >
                          戻す
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Pager pagination={pagination} onPage={onPage} />
    </>
  );
}

/** 解答履歴（prd/13 §7.3）。**1 行 1 解答**で、同じ問題の複数回はまとめない */
export function DrillHistory({
  rows,
  pagination,
  kind,
  filtered,
  onPage,
  onClearFilters,
}: {
  rows: DrillAttemptRow[];
  pagination: Pagination;
  kind: 'mate' | 'best' | undefined;
  /** 絞り込みが掛かっているか（`DrillList` と同じ理由） */
  filtered: boolean;
  onPage: (page: number) => void;
  onClearFilters: () => void;
}) {
  if (rows.length === 0) {
    return filtered ? (
      <p className="text-base-content/70 p-2">
        条件に合う解答がありません。
        <button className="link link-primary" onClick={onClearFilters}>
          条件をクリア
        </button>
      </p>
    ) : (
      <p className="text-base-content/70 p-2">まだ解答の記録がありません。</p>
    );
  }
  return (
    <>
      <div className="overflow-x-auto">
        <table className="table table-sm table-zebra">
          <thead>
            <tr>
              <th>解答日時</th>
              <th>棋譜</th>
              <th>手数</th>
              <th>種類</th>
              <th>指した手</th>
              <th>判定</th>
              <th>損失</th>
              <th>回数</th>
              <th className="w-px" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const verdict = row.verdict ? VERDICT_BADGE[row.verdict] : null;
              return (
                <tr key={row.id}>
                  <td className="whitespace-nowrap">{timeText(row.createdAt)}</td>
                  <td className="max-w-60 truncate">
                    <Link
                      to="/kifus/$id"
                      params={{ id: String(row.kifuId) }}
                      className="link link-hover"
                    >
                      {row.title}
                    </Link>
                  </td>
                  <td className="whitespace-nowrap">{row.moveNumber + 1} 手目</td>
                  <td className="whitespace-nowrap">{KIND_LABEL[row.kind]}</td>
                  <td className="whitespace-nowrap">{row.moveText ?? '—'}</td>
                  <td className="whitespace-nowrap">
                    {verdict ? (
                      <span className={`badge badge-sm whitespace-nowrap ${verdict.className}`}>
                        {verdict.label}
                      </span>
                    ) : (
                      // 「自明だった」の行（`move` / `verdict` が null。prd/13 §6.2）。
                      // 🔒 落とすと、一覧から問題が消えた理由を辿れない
                      <span className="badge badge-sm badge-outline">除外</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap">
                    {row.lossCp === null ? '—' : `${row.lossCp}cp`}
                  </td>
                  <td className="whitespace-nowrap">
                    {row.attemptNo === null ? '—' : `${row.attemptNo} 回目`}
                  </td>
                  <td className="w-px whitespace-nowrap">
                    <Link
                      to="/drills"
                      search={{ kind, drill: row.drillId }}
                      className="btn btn-xs"
                    >
                      解き直す
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Pager pagination={pagination} onPage={onPage} />
    </>
  );
}
