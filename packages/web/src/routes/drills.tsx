import { useState } from 'react';
import { createFileRoute, Link, useNavigate, useRouter } from '@tanstack/react-router';
import {
  canPromoteMove,
  dropDestinations,
  moveDestinations,
  parseSfen,
  usiToJapaneseWithPiece,
  type BoardState,
  type HandPieceKind,
  type SquareRef,
} from 'shared';
import { client } from '../lib/honoClient';
import { BoardGrid, HandDisplay } from '../components/BoardGrid';
import {
  applyStudyMoves,
  canTogglePromotion,
  currentState,
  isLastMovePromoted,
  lastMove,
  tapHand,
  tapSquare,
  togglePromotion,
  undo,
  type StudySession,
} from '../lib/study';
import { useDrillScoring } from '../lib/drillScoring';
import { DrillHistory, DrillList } from '../components/DrillTables';

/**
 * 出題（prd/13）。溜め込んだ棋譜と解析から作った問題を解く。
 *
 * 🔴 **棋譜詳細から出題しない**（prd/13 §7）——あの画面では答えが既に見えている。
 * ここには**出題局面と問いしか届かない**（正解手も候補手も server が持っている。prd/13 §5.3）。
 *
 * 🔒 **採点は server**。ここがやるのは盤の操作と、返ってきた判定の表示だけ。
 */
export interface DrillsSearch {
  /** タブ（prd/13 §7.4）。`solve` は既定なので URL に載せない */
  tab?: 'list' | 'history';
  /** 出題の種類で絞る。未指定なら両方から選ぶ。**タブをまたいで効く** */
  kind?: 'mate' | 'best';
  /** 一覧から名指しで開いた問題（`tab` が解くときだけ見る。prd/13 §7.4） */
  drill?: number;
  /** 一覧・履歴のページ（1 は既定なので載せない） */
  page?: number;
  /** 一覧の解答状況（`all` は既定）。⚠ 名前は棋譜一覧の `status` と**衝突させない**
   * （検索パラメータの型はルート間で突き合わされる） */
  solved?: 'unanswered' | 'wrong' | 'correct';
  /** 一覧で除外した問題だけを見る（既定は隠す） */
  excluded?: 'only';
  /** 一覧の並び（`played` は既定）。⚠ 棋譜一覧の `sort` と衝突させない */
  sortBy?: 'status';
  /** 履歴の判定（`all` は既定） */
  verdict?: 'correct' | 'close' | 'wrong' | 'excluded';
}

const TABS = ['list', 'history'] as const;
const KINDS = ['mate', 'best'] as const;
const STATUSES = ['unanswered', 'wrong', 'correct'] as const;
const VERDICTS = ['correct', 'close', 'wrong', 'excluded'] as const;

/** 許可値でなければ落とす（URL 直入力の未知の値は既定に戻す） */
function option<T extends string>(values: readonly T[], raw: unknown): T | undefined {
  return values.find((v) => v === raw);
}

/** 正の整数だけを受ける。1 は既定なので URL に載せない */
function pageParam(raw: unknown): number | undefined {
  const value = Number(raw);
  return Number.isInteger(value) && value > 1 ? value : undefined;
}

function idParam(raw: unknown): number | undefined {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

export const Route = createFileRoute('/drills')({
  validateSearch: (search: Record<string, unknown>): DrillsSearch => ({
    tab: option(TABS, search.tab),
    kind: option(KINDS, search.kind),
    drill: idParam(search.drill),
    page: pageParam(search.page),
    solved: option(STATUSES, search.solved),
    excluded: search.excluded === 'only' ? 'only' : undefined,
    sortBy: search.sortBy === 'status' ? 'status' : undefined,
    verdict: option(VERDICTS, search.verdict),
  }),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => loadTab(deps),
  component: DrillsPage,
});

type SolveResponse = Awaited<ReturnType<typeof loadNext>>;
type Drill = NonNullable<SolveResponse['drill']>;

/** タブごとに引くものが違う（prd/13 §7.4）。**タブは URL の検索パラメータ**なので loader で分ける */
async function loadTab(search: DrillsSearch) {
  if (search.tab === 'list') return { tab: 'list' as const, ...(await loadList(search)) };
  if (search.tab === 'history') return { tab: 'history' as const, ...(await loadHistory(search)) };
  const solve = search.drill ? await loadOne(search.drill) : await loadNext(search.kind);
  return { tab: 'solve' as const, ...solve };
}

async function loadNext(kind?: 'mate' | 'best') {
  try {
    const res = await client.api.drills.next.$get({ query: kind ? { kind } : {} });
    if (!res.ok) return { drill: null, error: `サーバーエラー (${res.status})` };
    const body = await res.json();
    return { drill: body.drill, error: null };
  } catch {
    return { drill: null, error: 'サーバーに接続できません' };
  }
}

/** 一覧から名指しで開いた 1 問（prd/13 §5.4）。返る形は `/drills/next` と同じ */
async function loadOne(id: number) {
  try {
    const res = await client.api.drills[':id'].$get({ param: { id: String(id) } });
    if (res.status === 404) return { drill: null, error: '出題が見つかりません' };
    if (!res.ok) return { drill: null, error: `サーバーエラー (${res.status})` };
    const body = await res.json();
    return { drill: body.drill, error: null };
  } catch {
    return { drill: null, error: 'サーバーに接続できません' };
  }
}

async function loadList(search: DrillsSearch) {
  try {
    const res = await client.api.drills.$get({
      query: {
        page: search.page ?? 1,
        ...(search.kind ? { kind: search.kind } : {}),
        ...(search.solved ? { status: search.solved } : {}),
        ...(search.excluded ? { excluded: search.excluded } : {}),
        ...(search.sortBy ? { sort: search.sortBy } : {}),
      },
    });
    if (!res.ok) return { list: null, error: `サーバーエラー (${res.status})` };
    return { list: await res.json(), error: null };
  } catch {
    return { list: null, error: 'サーバーに接続できません' };
  }
}

async function loadHistory(search: DrillsSearch) {
  try {
    const res = await client.api.drills.attempts.$get({
      query: {
        page: search.page ?? 1,
        ...(search.kind ? { kind: search.kind } : {}),
        ...(search.verdict ? { verdict: search.verdict } : {}),
      },
    });
    if (!res.ok) return { history: null, error: `サーバーエラー (${res.status})` };
    return { history: await res.json(), error: null };
  } catch {
    return { history: null, error: 'サーバーに接続できません' };
  }
}

/** 解答後に server が明かす情報（prd/13 §5.3） */
interface Reveal {
  verdict: 'correct' | 'close' | 'wrong';
  lossCp: number | null;
  refutation?: string[];
  kifuId: number;
  moveNumber: number;
  reason: 'missed_mate' | 'own_blunder';
  answerMove: string;
  answerPv: string[] | null;
  playedMove: string | null;
  playedLossCp: number | null;
}

const VERDICT_TEXT = {
  correct: { label: '正解', className: 'badge-success' },
  close: { label: '惜しい', className: 'badge-warning' },
  wrong: { label: '不正解', className: 'badge-error' },
} as const;

/** ポーリングの間隔と総予算。server の期限（最大 240 秒）に合わせて切る（prd/12 §2.4） */
const POLL_INTERVAL_MS = 1500;
const POLL_BUDGET_MS = 240_000;

/**
 * 🔴 **種類を変えたら中身ごと作り直す**（レビュー `OCL-5AC2D54A`）。出題は loader が
 * 引いた 1 問を state に持って進めるので、`key` を変えずに loader だけ走らせると
 * **「詰み」に切り替えたのに直前の次の一手が残る**。`key` で作り直せば、
 * 盤・手順・判定が**まとめて**新しい問題のものになる。
 */
function DrillsPage() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: '/drills' });
  const router = useRouter();
  /** 「戻す」の結果（prd/13 §7.2）。**失敗を黙って飲まない**——押しても何も起きないと読める */
  const [actionError, setActionError] = useState<string | null>(null);

  /** 絞り込みを変えたら 1 ページ目に戻す（棋譜一覧と同じ姿勢。prd/05 §2.5） */
  function setSearch(patch: Partial<DrillsSearch>) {
    navigate({ search: (prev) => ({ ...prev, page: undefined, ...patch }) });
  }

  /** 絞り込みをすべて外す（タブは保つ）。0 件のときの案内から呼ぶ */
  function clearFilters() {
    navigate({ search: { tab: search.tab } });
  }

  async function unexclude(id: number) {
    // 🔴 **応答を確かめてから引き直す**（レビュー `OCL-63C7DD79`）。POST だけが失敗して
    // GET が成功すると、**除外されたままの一覧が普通に描き直される**——押した側からは
    // 「効かなかった」ことも理由も分からない
    try {
      const res = await client.api.drills[':id'].unexclude.$post({ param: { id: String(id) } });
      if (!res.ok) {
        setActionError(`除外を戻せませんでした (${res.status})`);
        return;
      }
      setActionError(null);
      await router.invalidate();
    } catch {
      setActionError('サーバーに接続できません');
    }
  }

  return (
    <div className="p-2 space-y-2">
      <DrillTabs search={search} />

      {data.tab === 'solve' && (
        // 🔴 **問題が変わったら中身ごと作り直す**（レビュー `OCL-5AC2D54A`）。
        // 盤・手順・判定を state に持って進める画面なので、loader だけ走らせると前の問題が残る
        <DrillRunner
          key={`${search.kind ?? 'all'}-${search.drill ?? 'next'}`}
          initial={data}
          kind={search.kind}
          pinned={search.drill !== undefined}
          onUnpin={() => navigate({ search: (prev) => ({ ...prev, drill: undefined }) })}
        />
      )}

      {data.tab === 'list' && (
        <>
          <div className="flex items-center gap-2 flex-wrap">
            <select
              className="select select-sm"
              value={search.solved ?? 'all'}
              onChange={(e) =>
                setSearch({ solved: option(STATUSES, e.target.value) })
              }
            >
              <option value="all">すべての状態</option>
              <option value="unanswered">未解答</option>
              <option value="wrong">間違えた</option>
              <option value="correct">正解した</option>
            </select>
            <select
              className="select select-sm"
              value={search.sortBy ?? 'played'}
              onChange={(e) =>
                setSearch({ sortBy: e.target.value === 'status' ? 'status' : undefined })
              }
            >
              <option value="played">対局日順</option>
              <option value="status">出題順</option>
            </select>
            <label className="label cursor-pointer gap-1 text-sm">
              <input
                type="checkbox"
                className="checkbox checkbox-sm"
                checked={search.excluded === 'only'}
                onChange={(e) => setSearch({ excluded: e.target.checked ? 'only' : undefined })}
              />
              除外した問題
            </label>
            {data.list && (
              <span className="text-sm text-base-content/70 ms-auto">
                {data.list.pagination.total} 問
              </span>
            )}
          </div>
          {data.error && <p className="text-error text-sm">{data.error}</p>}
          {actionError && <p className="text-error text-sm">{actionError}</p>}
          {data.list && (
            <DrillList
              rows={data.list.drills}
              pagination={data.list.pagination}
              kind={search.kind}
              filtered={Boolean(search.kind || search.solved || search.excluded)}
              excludedOnly={search.excluded === 'only'}
              onPage={(page) => navigate({ search: (prev) => ({ ...prev, page }) })}
              onClearFilters={clearFilters}
              onUnexclude={unexclude}
            />
          )}
        </>
      )}

      {data.tab === 'history' && (
        <>
          <div className="flex items-center gap-2 flex-wrap">
            <select
              className="select select-sm"
              value={search.verdict ?? 'all'}
              onChange={(e) => setSearch({ verdict: option(VERDICTS, e.target.value) })}
            >
              <option value="all">すべての判定</option>
              <option value="correct">正解</option>
              <option value="close">惜しい</option>
              <option value="wrong">不正解</option>
              <option value="excluded">除外</option>
            </select>
            {data.history && (
              <span className="text-sm text-base-content/70 ms-auto">
                {data.history.pagination.total} 件
              </span>
            )}
          </div>
          {data.error && <p className="text-error text-sm">{data.error}</p>}
          {data.history && (
            <DrillHistory
              rows={data.history.attempts}
              pagination={data.history.pagination}
              kind={search.kind}
              filtered={Boolean(search.kind || search.verdict)}
              onPage={(page) => navigate({ search: (prev) => ({ ...prev, page }) })}
              onClearFilters={clearFilters}
            />
          )}
        </>
      )}
    </div>
  );
}

/**
 * タブと種類の絞り込み（prd/13 §7.4）。
 *
 * 🔒 **`kind` はタブをまたいで効く**（3 つとも種類で絞る意味がある）。
 * ⚠ **タブを移ったらタブ固有のつまみは落とす**（`page` / `solved` / `verdict` など）。
 */
function DrillTabs({ search }: { search: DrillsSearch }) {
  const tab = search.tab ?? 'solve';
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <div role="tablist" className="tabs tabs-box tabs-sm">
        {(
          [
            [undefined, '解く'],
            ['list', '一覧'],
            ['history', '履歴'],
          ] as const
        ).map(([value, label]) => (
          <Link
            key={label}
            role="tab"
            to="/drills"
            search={{ tab: value, kind: search.kind }}
            className={`tab ${tab === (value ?? 'solve') ? 'tab-active' : ''}`}
          >
            {label}
          </Link>
        ))}
      </div>
      {/* 種類の絞り込み。**答えの手掛かりにはならない**ので出題中に出してよい */}
      <div className="join ms-auto">
        {(
          [
            [undefined, 'すべて'],
            ['mate', '詰み'],
            ['best', '次の一手'],
          ] as const
        ).map(([value, label]) => (
          <Link
            key={label}
            to="/drills"
            search={{ ...search, kind: value, page: undefined, drill: undefined }}
            className={`btn btn-xs join-item ${search.kind === value ? 'btn-active' : ''}`}
          >
            {label}
          </Link>
        ))}
      </div>
    </div>
  );
}

function DrillRunner({
  initial,
  kind,
  pinned,
  onUnpin,
}: {
  initial: SolveResponse;
  kind: 'mate' | 'best' | undefined;
  /** 一覧から名指しで開いた問題か（prd/13 §7.4）。次の問題へ進むときに `drill` を落とす */
  pinned: boolean;
  onUnpin: () => void;
}) {
  const { scoring } = useDrillScoring();
  const [drill, setDrill] = useState<Drill | null>(initial.drill);
  const [error, setError] = useState<string | null>(initial.error);
  /** 出題局面からの確定した手順（受方の応手を含む。prd/13 §5.3） */
  const [line, setLine] = useState<string[]>([]);
  const [session, setSession] = useState<StudySession | null>(() => sessionOf(initial.drill, []));
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [judging, setJudging] = useState(false);

  const base = drill ? parseSfen(drill.sfen) : null;
  const state = session ? currentState(session) : base;
  // ⚠ **解いている側を下に置く**（自分の手番の局面しか出題されない。prd/13 §4.1）
  const flipped = base?.sideToMove === 'gote';
  /** 確定前の 1 手（盤で動かしたが、まだ答えていない手） */
  const pending = session && session.steps.length > line.length + 1 ? lastMove(session) : null;

  function reset(next: Drill | null, message: string | null = null) {
    setDrill(next);
    setError(message);
    setLine([]);
    setSession(sessionOf(next, []));
    setReveal(null);
    setJudging(false);
  }

  async function nextDrill() {
    // ⚠ **一覧から開いた問題は URL に残っている**（prd/13 §7.4）。落とさないと同じ問題が出続ける
    if (pinned) {
      onUnpin();
      return;
    }
    const loaded = await loadNext(kind);
    reset(loaded.drill, loaded.error);
  }

  /**
   * 盤を叩く。⚠ **動かせるのは手番側の駒だけ**（出題は自分の手番の局面。prd/13 §4.1）。
   *
   * 🔴 **行き先も候補に無ければ受け付けない**（レビュー `OCL-1A2B07B9`）。塗るだけだと
   * **歩を横に動かす・飛車が駒を飛び越える**といった手を盤から作れてしまい、
   * server の検証（`validateMoveOnPosition`）は駒の動き方を見ないので**エンジンまで届く**。
   * ⚠ 検討盤（フル編集）はこの制限を持たない——**出題だけの規則**。
   */
  function onSquare(square: SquareRef) {
    if (!session || reveal || judging || pending) return;
    const current = currentState(session);
    const piece = current.board[square.row][square.col];
    if (session.selection === null) {
      if (piece?.side !== current.sideToMove) return;
      setSession(tapSquare(session, square));
      return;
    }
    // 選択の解除（同じマスをもう一度叩く）は候補の外でも通す
    if (
      session.selection.kind === 'square' &&
      session.selection.square.row === square.row &&
      session.selection.square.col === square.col
    ) {
      setSession(tapSquare(session, square));
      return;
    }
    const allowed = destinationsOf(session) ?? [];
    if (!allowed.some((d) => d.row === square.row && d.col === square.col)) return;
    setSession(tapSquare(session, square));
  }

  function onHand(kind: HandPieceKind) {
    if (!session || reveal || judging || pending) return;
    setSession(tapHand(session, currentState(session).sideToMove, kind));
  }

  async function answer(move: string) {
    if (!drill) return;
    setJudging(true);
    setError(null);
    const body = { line: [...line, move], ...scoring };
    const deadline = Date.now() + POLL_BUDGET_MS;
    try {
      while (Date.now() < deadline) {
        const res = await client.api.drills[':id'].answer.$post({
          param: { id: String(drill.id) },
          json: body,
        });
        // ⚠ **本文のパースはステータス判定より後**（前段が返す HTML で落ちると、
        // 通信断でもないのに「接続できません」と出る。prd/12 §2.4）
        if (res.status === 202) {
          const { jobId } = (await res.json()) as { jobId: string };
          await waitForEvaluation(jobId, deadline);
          continue;
        }
        if (!res.ok) {
          const detail = await res.json().catch(() => null);
          setError(errorTextOf(detail, res.status));
          setJudging(false);
          return;
        }
        const result = (await res.json()) as
          | { status: 'continue'; reply: string }
          | ({ status: 'done' } & Reveal);
        if (result.status === 'continue') {
          // 詰みの指し継ぎ。受方の応手まで進めて次の手を待つ（prd/13 §5.2）
          const advanced = [...line, move, result.reply];
          setLine(advanced);
          setSession(sessionOf(drill, advanced));
          setJudging(false);
          return;
        }
        setReveal(result);
        setJudging(false);
        return;
      }
      setError('判定が終わりませんでした。もう一度お試しください');
      setJudging(false);
    } catch {
      setError('サーバーに接続できません');
      setJudging(false);
    }
  }

  async function exclude() {
    if (!drill) return;
    await client.api.drills[':id'].exclude.$post({ param: { id: String(drill.id) } });
    await nextDrill();
  }

  if (error && !drill) {
    return <p className="text-error p-2">{error}</p>;
  }
  if (!drill || !state) {
    return (
      <p className="text-base-content/70 p-2">
        出題できる問題がありません。解析済みの棋譜が増えると問題が作られます。
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <h1 className="text-lg font-bold">
          {drill.kind === 'mate' ? '詰ませてください' : 'ここで何を指すべきでしたか'}
        </h1>
        {drill.kind === 'mate' && drill.matePlies !== null && (
          <span className="badge badge-ghost">{drill.matePlies}手で詰み</span>
        )}
        {drill.wrongBefore && !reveal && (
          <span className="badge badge-warning badge-outline">以前間違えた</span>
        )}
      </div>

      <HandDisplay
        hand={state.hand[flipped ? 'sente' : 'gote']}
        side={flipped ? 'sente' : 'gote'}
        flipped={flipped}
      />
      <BoardGrid
        state={state}
        lastMoveTo={null}
        flipped={flipped}
        onSquareClick={reveal ? undefined : onSquare}
        selected={session?.selection?.kind === 'square' ? session.selection.square : null}
        destinations={destinationsOf(session)}
      />
      <HandDisplay
        hand={state.hand[flipped ? 'gote' : 'sente']}
        side={flipped ? 'gote' : 'sente'}
        flipped={flipped}
        onPieceClick={reveal || judging ? undefined : onHand}
        selected={session?.selection?.kind === 'hand' ? session.selection.piece : null}
      />

      {error && <p className="text-error text-sm">{error}</p>}

      {judging && (
        <p className="text-sm text-base-content/70">
          <span className="loading loading-spinner loading-xs align-middle mr-1" />
          判定しています
        </p>
      )}

      {pending && !reveal && !judging && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm">
            {usiToJapaneseWithPiece(session!.steps[session!.cursor - 1].state, pending)}
          </span>
          {/*
            🔒 **成れる手のときだけ「成」を出す。** 検討盤の `canTogglePromotion` は
            フル編集向けで打った駒まで成らせるため、そのまま使うと
            **押せるのに server が 400（illegal_promotion）を返すボタン**ができる。
            規則は `shared` の `canPromoteMove`（server の検証と同じ出所）。
          */}
          {canPromoteMove(session!.steps[session!.cursor - 1].state, pending) &&
            canTogglePromotion(session!) && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setSession(togglePromotion(session!))}
              >
                {isLastMovePromoted(session!) ? '不成' : '成'}
              </button>
            )}
          <button type="button" className="btn btn-sm" onClick={() => setSession(undo(session!))}>
            戻す
          </button>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => answer(pending)}>
            この手で答える
          </button>
        </div>
      )}

      {reveal && (
        <Result
          reveal={reveal}
          drill={drill}
          base={base!}
          // 咎め筋は**答えた手を指した後**の局面から読む（相手の応手から始まるため）
          answered={state}
          onNext={nextDrill}
          onExclude={exclude}
        />
      )}
    </div>
  );
}

/** 解答後の表示。**ここで初めて棋譜・手数・正解が出る**（prd/13 §7） */
function Result({
  reveal,
  drill,
  base,
  answered,
  onNext,
  onExclude,
}: {
  reveal: Reveal;
  drill: Drill;
  base: BoardState;
  /** 答えた手を指した後の局面（咎め筋の読み出しに使う） */
  answered: BoardState;
  onNext: () => void;
  onExclude: () => void;
}) {
  const verdict = VERDICT_TEXT[reveal.verdict];
  return (
    <div className="card bg-base-200 p-3 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`badge ${verdict.className}`}>{verdict.label}</span>
        {reveal.lossCp !== null && (
          <span className="text-sm">損失 {reveal.lossCp}cp</span>
        )}
        <span className="text-sm">
          正解 {usiToJapaneseWithPiece(base, reveal.answerMove)}
        </span>
      </div>

      {drill.kind === 'mate' && reveal.answerPv && (
        <p className="text-sm break-all">
          詰み手順 {movesText(base, reveal.answerPv)}
        </p>
      )}
      {reveal.refutation && reveal.refutation.length > 0 && (
        <p className="text-sm break-all">
          咎め筋 {movesText(answered, reveal.refutation)}
        </p>
      )}
      {reveal.playedMove && (
        <p className="text-sm">
          実戦は {usiToJapaneseWithPiece(base, reveal.playedMove)}
          {reveal.playedLossCp !== null && `（損失 ${reveal.playedLossCp}cp）`}
        </p>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <button type="button" className="btn btn-sm btn-primary" onClick={onNext}>
          次の問題
        </button>
        {/*
          出題局面の**次の手**（＝この問題の手）まで進めた状態で開く。
          `moveNumber` は 0 始まりの指し手番号なので、盤の手数（初期局面からの手数）は +1。
          こうすると開いた瞬間にその手の評価値・候補手が出る（prd/13 §7.1）
        */}
        <Link
          to="/kifus/$id"
          params={{ id: String(reveal.kifuId) }}
          search={{ ply: reveal.moveNumber + 1 }}
          className="btn btn-sm"
        >
          この対局の {reveal.moveNumber + 1} 手目を見る
        </Link>
        {/* 🔒 自動判定は作らない（「取り返し」の定義から詰まる。prd/13 §4.2） */}
        <button type="button" className="btn btn-sm btn-ghost" onClick={onExclude}>
          自明だった
        </button>
      </div>
    </div>
  );
}

/** 出題局面 + 確定した手順からセッションを作る */
function sessionOf(drill: Drill | null, line: string[]): StudySession | null {
  if (!drill) return null;
  const base = parseSfen(drill.sfen);
  return base ? applyStudyMoves(base, line) : null;
}

/** 選択中の駒が動けるマス（prd/13 §3）。**盤の見た目の助けで、合否には使わない** */
function destinationsOf(session: StudySession | null): SquareRef[] | null {
  if (!session?.selection) return null;
  const state = currentState(session);
  return session.selection.kind === 'square'
    ? moveDestinations(state, session.selection.square)
    : dropDestinations(state, session.selection.side, session.selection.piece);
}

/** 読み筋を日本語にする（盤面を進めながら読むので `shared` の変換をそのまま使う） */
function movesText(base: BoardState, moves: string[]): string {
  const session = applyStudyMoves(base, moves);
  return moves
    .map((move, i) => usiToJapaneseWithPiece(session.steps[i].state, move))
    .join(' ');
}

/** 判定が出るまで待つ。**ポーリングは呼び出し側から見えない**（prd/12 §2.4） */
async function waitForEvaluation(jobId: string, deadline: number): Promise<void> {
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const res = await client.api.positions.evaluate[':jobId'].$get({ param: { jobId } });
    // 404 は TTL 切れ / server 再起動。**同じ body を投げ直せばよい**ので待ちを抜ける
    if (res.status === 404) return;
    if (!res.ok) return;
    const body = (await res.json()) as { status?: string };
    if (body.status !== 'pending') return;
  }
}

function errorTextOf(detail: unknown, status: number): string {
  if (detail && typeof detail === 'object' && 'error' in detail) {
    return String((detail as { error: unknown }).error);
  }
  return `サーバーエラー (${status})`;
}
