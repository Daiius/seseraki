import type { CSSProperties } from 'react';
import { Link } from '@tanstack/react-router';
import { parseSfen, type BoardState, type PieceKind } from 'shared';
import type { InferResponseType } from 'hono/client';
import { BoardGrid, HAND_ORDER, PIECE_DISPLAY } from './BoardGrid';
import { Pager } from './Pager';
import { client } from '../lib/honoClient';
import { refOf, solveFromListSearch, type DrillRef, type DrillsSearch } from '../lib/drillSearch';
import { attemptMoveLabel } from '../lib/drillAnswer';

/*
 * 出題の問題の一覧（カード）と、その問題の解答履歴（prd/13 §7.7）。
 *
 * 🔴 **答えは出さない**（正解手・実戦の手・損失）。盤の縮図は出題局面なので答えではない。
 * ⚠ 棋譜名と棋譜詳細への導線はカードに載せない（狭い幅を取る。対局へは解いた後の「元の対局」で辿る）。
 * 🔒 問題は（棋譜の番号・手数・種類）で指す（prd/14 §4.4）。出題・解答の行の ID は API から来ない。
 */

/** 一覧の 1 行（`GET /api/drills` の `drills`） */
type DrillCardRow = InferResponseType<typeof client.api.drills.$get, 200>['drills'][number];
type ListPagination = InferResponseType<typeof client.api.drills.$get, 200>['pagination'];

/** 解答履歴の 1 行（`GET /api/drills/:kifuNo/:moveNumber/:kind/attempts` の `attempts`） */
export type DrillAttemptRow = InferResponseType<
  (typeof client.api.drills)[':kifuNo'][':moveNumber'][':kind']['attempts']['$get'],
  200
>['attempts'][number];

/** 状態の札（prd/13 §7.7）。除外は状態より優先して出す */
const STATUS_BADGE = {
  unanswered: { label: '未解答', className: 'badge-ghost' },
  wrong: { label: '間違えた', className: 'badge-warning' },
  correct: { label: '正解', className: 'badge-success' },
  excluded: { label: '除外', className: 'badge-outline' },
} as const;

const VERDICT_BADGE = {
  correct: { label: '正解', className: 'badge-success' },
  close: { label: '惜しい', className: 'badge-warning' },
  wrong: { label: '不正解', className: 'badge-error' },
} as const;

/** 種類（詰将棋なら手数。出題中のバッジと同じエンジンの手数） */
function drillKindText(kind: 'mate' | 'best', matePlies: number | null): string {
  if (kind === 'best') return '次の一手';
  return matePlies === null ? '詰将棋' : `詰将棋 ${matePlies}手`;
}

function dateText(value: string | null, fallback?: string): string {
  const source = value ?? fallback ?? null;
  return source ? new Date(source).toLocaleDateString('ja-JP') : '—';
}

function timeText(value: string): string {
  return new Date(value).toLocaleString('ja-JP');
}

/** 盤の縮図の 1 マスの寸法。カードを横に並べても 1 列のスマホ幅に収まる大きさ */
const THUMB_SQ = '0.95rem';

/** 縮図の持ち駒（1 行の文字。盤の縮図に合わせて小さく） */
function MiniHand({ hand, mark }: { hand: Partial<Record<PieceKind, number>>; mark: string }) {
  const pieces = HAND_ORDER.flatMap((kind) => {
    const count = hand[kind];
    if (!count) return [];
    return [`${PIECE_DISPLAY[kind]}${count > 1 ? count : ''}`];
  });
  return (
    <div className="text-[0.65rem] leading-tight text-base-content/70 truncate">
      {mark} {pieces.length > 0 ? pieces.join(' ') : 'なし'}
    </div>
  );
}

/**
 * 出題局面の小さな盤の縮図（prd/13 §7.7）。**解く画面と同じ向き**（解く側を下）。
 * 盤は解く画面・検討盤と同じ `BoardGrid` を、マスの寸法（`--sq`）だけ小さくして描く（盤の見た目を複製しない）
 */
function DrillThumbnail({ state }: { state: BoardState }) {
  const flipped = state.sideToMove === 'gote';
  const top = flipped ? 'sente' : 'gote';
  const bottom = flipped ? 'gote' : 'sente';
  const mark = { sente: '☗', gote: '☖' } as const;
  return (
    <div className="shrink-0 pointer-events-none" style={{ '--sq': THUMB_SQ } as CSSProperties}>
      <MiniHand hand={state.hand[top]} mark={mark[top]} />
      <BoardGrid state={state} lastMoveTo={null} flipped={flipped} />
      <MiniHand hand={state.hand[bottom]} mark={mark[bottom]} />
    </div>
  );
}

/** 問題の一覧（カード。prd/13 §7.7）。**押すとその問題を解く** */
export function DrillCardList({
  rows,
  pagination,
  search,
  filtered,
  onPage,
  onClearFilters,
  onUnexclude,
}: {
  rows: DrillCardRow[];
  pagination: ListPagination;
  /** 今の一覧の検索パラメータ（開いた問題から同じ一覧へ戻るため） */
  search: DrillsSearch;
  /** 絞り込みが掛かっているか。**0 件の案内を出し分ける**（prd/05 §2.5 と同じ姿勢） */
  filtered: boolean;
  onPage: (page: number) => void;
  onClearFilters: () => void;
  onUnexclude: (ref: DrillRef) => void;
}) {
  if (rows.length === 0) {
    // 条件に合う問題はあるのに、このページには無い（件数が減った・URL が範囲外）。
    // 🔴 **0 件の案内で早期に返さない**——ページ送りごと消えると前のページへ戻れなくなる（レビュー `OCL-19F01A13`）
    if (pagination.total > 0) {
      return (
        <>
          <p className="text-base-content/70 p-2">
            このページには表示するものがありません（全 {pagination.total} 問）。
            <button className="link link-primary" onClick={() => onPage(pagination.totalPages)}>
              最後のページへ
            </button>
          </p>
          <Pager pagination={pagination} onPage={onPage} />
        </>
      );
    }
    // ⚠ **「問題がまだ無い」と「絞り込みの結果が空」を同じ文言にしない**
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
      {/* スマホ前提で狭い幅では 1 列（prd/13 §7.7） */}
      <ul className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
        {rows.map((row) => {
          const ref = refOf(row);
          const status = STATUS_BADGE[row.excluded ? 'excluded' : row.status];
          const state = row.sfen ? parseSfen(row.sfen) : null;
          return (
            <li
              key={`${row.kifuNo}-${row.moveNumber}-${row.kind}`}
              className="card card-border bg-base-100 p-2"
            >
              <Link
                to="/drills"
                search={solveFromListSearch(search, ref)}
                className="flex gap-3 items-start hover:bg-base-200 rounded"
                aria-label={`${drillKindText(row.kind, row.matePlies)}を解く`}
              >
                {state ? (
                  <DrillThumbnail state={state} />
                ) : (
                  <div className="text-xs text-base-content/60 p-2">盤面を表示できません</div>
                )}
                <div className="flex flex-col gap-1 text-sm min-w-0">
                  <span className="font-semibold">{drillKindText(row.kind, row.matePlies)}</span>
                  <span>
                    <span className={`badge badge-sm whitespace-nowrap ${status.className}`}>
                      {status.label}
                    </span>
                  </span>
                  <span className="text-base-content/70">
                    {row.answers === 0 ? '解答なし' : `解答 ${row.answers} 回`}
                  </span>
                  <span className="text-base-content/70">
                    対局日 {dateText(row.playedAt, row.kifuCreatedAt)}
                  </span>
                </div>
              </Link>
              {/* 除外の取り消し（prd/13 §7.7）。外した理由を後から見直せないと、押すのが怖くなる */}
              {row.excluded && (
                <button
                  type="button"
                  className="btn btn-xs btn-ghost self-end mt-1"
                  onClick={() => onUnexclude(ref)}
                >
                  除外を取り消す
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <Pager pagination={pagination} onPage={onPage} />
    </>
  );
}

/**
 * その問題の解答履歴（prd/13 §7.7）。**1 行 1 解答**で新しい順。
 * 🔒 **解いた後にだけ出す**——正解の記録の「指した手」は答えそのもの。
 */
export function DrillAttemptHistory({ rows }: { rows: DrillAttemptRow[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-base-content/70">まだ記録がありません。</p>;
  }
  return (
    <ul className="divide-y divide-base-300 text-sm">
      {rows.map((row, i) => {
        const verdict = row.verdict ? VERDICT_BADGE[row.verdict] : null;
        return (
          // 解答の行の ID は API から来ない（prd/14 §4.4）。並びは固定なので位置で区別する
          <li key={`${row.createdAt}-${i}`} className="py-1 flex items-center gap-2 flex-wrap">
            <span className="text-base-content/70 whitespace-nowrap">{timeText(row.createdAt)}</span>
            {verdict ? (
              <span className={`badge badge-sm whitespace-nowrap ${verdict.className}`}>
                {verdict.label}
              </span>
            ) : (
              // 「自明だった」の行（`move` / `verdict` が null。prd/13 §6.2）
              <span className="badge badge-sm badge-outline">除外</span>
            )}
            <span className="whitespace-nowrap">{attemptMoveLabel(row)}</span>
            {row.lossCp !== null && <span className="whitespace-nowrap">損失 {row.lossCp}cp</span>}
            {row.attemptNo !== null && (
              <span className="text-base-content/60 whitespace-nowrap ms-auto">{row.attemptNo} 回目</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
