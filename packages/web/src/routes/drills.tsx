import { useState } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
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

/**
 * 出題（prd/13）。溜め込んだ棋譜と解析から作った問題を解く。
 *
 * 🔴 **棋譜詳細から出題しない**（prd/13 §7）——あの画面では答えが既に見えている。
 * ここには**出題局面と問いしか届かない**（正解手も候補手も server が持っている。prd/13 §5.3）。
 *
 * 🔒 **採点は server**。ここがやるのは盤の操作と、返ってきた判定の表示だけ。
 */
export interface DrillsSearch {
  /** 出題の種類で絞る。未指定なら両方から選ぶ */
  kind?: 'mate' | 'best';
}

export const Route = createFileRoute('/drills')({
  validateSearch: (search: Record<string, unknown>): DrillsSearch => ({
    kind: search.kind === 'mate' || search.kind === 'best' ? search.kind : undefined,
  }),
  loaderDeps: ({ search }) => ({ kind: search.kind }),
  loader: ({ deps }) => loadNext(deps.kind),
  component: DrillsPage,
});

type NextResponse = Awaited<ReturnType<typeof loadNext>>;
type Drill = NonNullable<NextResponse['drill']>;

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
  const initial = Route.useLoaderData() as NextResponse;
  const { kind } = Route.useSearch();
  return <DrillRunner key={kind ?? 'all'} initial={initial} kind={kind} />;
}

function DrillRunner({
  initial,
  kind,
}: {
  initial: NextResponse;
  kind: 'mate' | 'best' | undefined;
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
    return <p className="p-4 text-error">{error}</p>;
  }
  if (!drill || !state) {
    return (
      <div className="p-4 space-y-2">
        <h1 className="text-lg font-bold">出題</h1>
        <p className="text-base-content/70">
          出題できる問題がありません。解析済みの棋譜が増えると問題が作られます。
        </p>
      </div>
    );
  }

  return (
    <div className="p-2 space-y-2">
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
              search={{ kind: value }}
              className={`btn btn-xs join-item ${kind === value ? 'btn-active' : ''}`}
            >
              {label}
            </Link>
          ))}
        </div>
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
          ⚠ **手数までは飛べない**（棋譜詳細は手数を URL に持たない）。
          「N 手目を見る」と書くとその手に飛ぶと読めるので、**手数は文の中に留める**
        */}
        <Link to="/kifus/$id" params={{ id: String(reveal.kifuId) }} className="btn btn-sm">
          この対局を見る（{reveal.moveNumber + 1} 手目）
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
