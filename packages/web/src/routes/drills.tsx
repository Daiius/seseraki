import { useEffect, useState, useSyncExternalStore } from 'react';
import { createFileRoute, Link, redirect, useNavigate, useRouter } from '@tanstack/react-router';
import {
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
  selectionDestinations,
  tapHand,
  tapSquare,
  togglePromotion,
  undo,
  type StudySession,
} from '../lib/study';
import { useDrillScoring } from '../lib/drillScoring';
import { DrillAttemptHistory, DrillCardList, type DrillAttemptRow } from '../components/DrillCards';
import { BrowserAnalysisNotice } from '../components/BrowserAnalysis';
import {
  answerBodyWithEvaluation,
  answerStepOf,
  lineAfterUndoTurn,
  matePliesText,
  missText,
  practiceNote,
  resultBadge,
  type AnswerBody,
  type MissReason,
} from '../lib/drillAnswer';
import { gradingFailureMessage, requestBrowserGrading } from '../lib/browserAnalysis/grading';
import {
  getBrowserAnalysisState,
  subscribeBrowserAnalysisState,
} from '../lib/browserAnalysis/store';
import {
  drillRefOf,
  drillScreenOf,
  listSearch,
  MODE_LABEL,
  MODES,
  modeSearch,
  option,
  pinnedSearch,
  STATUSES,
  validateDrillsSearch,
  type DrillMode,
  type DrillRef,
  type DrillsSearch,
} from '../lib/drillSearch';
import { drillRound, roundText } from '../lib/drillRound';

/**
 * 出題（prd/13）。溜め込んだ棋譜と解析から作った問題を解く。
 *
 * 画面は検索パラメータで決まる（prd/13 §7.8。`lib/drillSearch.ts`）: ホーム（入口 4 つと一覧へのリンク。§7.5）→
 * 解く画面（入口の在庫が尽きるまで区切らずに続く。§7.6）/ 問題の一覧（カード。§7.7）。
 *
 * 🔴 **棋譜詳細から出題しない**（prd/13 §7）——あの画面では答えが既に見えている。
 * ここには**出題局面と問いしか届かない**（正解手も候補手も server が持っている。prd/13 §5.3）。
 *
 * 🔒 **採点は server**。ここがやるのは盤の操作と、返ってきた判定の表示だけ。
 * 候補手の外の答えで server が「この局面のこの手を名指しで読んで」と返したら（ブラウザで解析する利用者。prd/13 §5.3）、
 * このブラウザのエンジンで読んだ結果を付けて同じ解答を送り直す。読めない端末では「採点できない」旨を出す（推測で判定しない）。
 */
export const Route = createFileRoute('/drills')({
  validateSearch: validateDrillsSearch,
  loaderDeps: ({ search }) => search,
  loader: {
    handler: ({ deps, preload }) => loadScreen(deps, preload),
    // 🔒 **読み直しを裏で走らせない**（prd/13 §7.4）。既定の stale-while-revalidate だと、
    // 戻るボタンで**古い読み込み結果を描いたあとに**新しい結果が届き、解きかけの盤が
    // 作り直される（`key` が読み込みごとに変わるため）。待ってから 1 度だけ描く
    staleReloadMode: 'blocking',
  },
  component: DrillsPage,
});

type Drill = NonNullable<Awaited<ReturnType<typeof loadOne>>['drill']>;
type SolveData = { drill: Drill | null; error: string | null };

/**
 * 解く画面の読み込みの通し番号。**読み込むたびに盤を作り直す**ための `key`。
 * ⚠ 問題（棋譜の番号・手数・種類）だけを `key` にすると、「次の問題」で**同じ問題がまた選ばれた**とき
 * （段の中はランダム。prd/13 §6.4）に作り直されず、解答後の表示が残る
 */
let solveLoads = 0;

/** 画面ごとに引くものが違う（prd/13 §7.8）。**画面は URL の検索パラメータ**なので loader で分ける */
async function loadScreen(search: DrillsSearch, preload: boolean) {
  const screen = drillScreenOf(search);
  if (screen === 'home') {
    // 🔒 **ホームに戻ったら「この回」を終える**（prd/13 §7.6）。先読みでは触らない
    if (!preload) drillRound.end();
    return { screen: 'home' as const, ...(await loadCounts()) };
  }
  if (screen === 'list') return { screen: 'list' as const, ...(await loadList(search)) };

  if (!preload) drillRound.ensure();
  const ref = drillRefOf(search);
  if (ref) {
    return { screen: 'solve' as const, load: ++solveLoads, exhausted: false, ...(await loadOne(ref)) };
  }
  const mode = search.mode ?? 'recommend';
  const next = await loadNext(mode, drillRound.get()?.since ?? null);
  // この回の開始時刻は server の時刻で決める（端末の時計のずれで、この回の記録を取りこぼさない）
  if (next.now && !preload) drillRound.startAt(next.now);
  // 🔒 **選んだ問題を URL に載せる**（prd/13 §7.8）。載せないと、棋譜詳細から戻ったときに
  // loader が**別の問題を選び直す**。loader の redirect は router が **replace** で扱うので
  // 履歴は積まれない。置き換え先は問題を指すので 2 度目は `loadOne` に入り、ループしない
  // ⚠ 取得は 2 回になる（next → 名指し）が、**取得経路を loader の 1 本に保つ**方を取る
  const pinned = next.drill ? pinnedSearch(search, refOf(next.drill)) : null;
  if (pinned) throw redirect({ to: '/drills', search: pinned });
  return {
    screen: 'solve' as const,
    load: ++solveLoads,
    // 在庫が尽きた（prd/13 §6.4）。取得の失敗とは分ける
    exhausted: next.error === null && next.drill === null,
    drill: next.drill,
    error: next.error,
  };
}

async function loadCounts() {
  try {
    const res = await client.api.drills.counts.$get();
    if (!res.ok) return { counts: null, error: `サーバーエラー (${res.status})` };
    return { counts: await res.json(), error: null };
  } catch {
    return { counts: null, error: 'サーバーに接続できません' };
  }
}

async function loadNext(mode: DrillMode, since: string | null) {
  try {
    const res = await client.api.drills.next.$get({ query: { mode, ...(since ? { since } : {}) } });
    if (!res.ok) return { drill: null, now: null, error: `サーバーエラー (${res.status})` };
    const body = await res.json();
    return { drill: body.drill, now: body.now, error: null };
  } catch {
    return { drill: null, now: null, error: 'サーバーに接続できません' };
  }
}

/** 問題を指す組（棋譜の番号・手数・種類。prd/14 §4.4）を API のパス引数へ */
function refParam(ref: DrillRef) {
  return {
    kifuNo: String(ref.kifuNo),
    moveNumber: String(ref.moveNumber),
    kind: ref.kind,
  };
}

/** 出題（`/drills/next` などが返す 1 問）から、それを指す組を取り出す */
function refOf(drill: DrillRef): DrillRef {
  return { kifuNo: drill.kifuNo, moveNumber: drill.moveNumber, kind: drill.kind };
}

/** 名指しの 1 問（prd/13 §5.4）。返る形は `/drills/next` と同じ */
async function loadOne(ref: DrillRef) {
  try {
    const res = await client.api.drills[':kifuNo'][':moveNumber'][':kind'].$get({
      param: refParam(ref),
    });
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
      },
    });
    if (!res.ok) return { list: null, error: `サーバーエラー (${res.status})` };
    return { list: await res.json(), error: null };
  } catch {
    return { list: null, error: 'サーバーに接続できません' };
  }
}

function DrillsPage() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  return (
    <div className="p-2 space-y-2">
      {data.screen === 'home' && <DrillHome counts={data.counts} error={data.error} />}
      {data.screen === 'list' && <DrillListScreen list={data.list} error={data.error} search={search} />}
      {data.screen === 'solve' && (
        <>
          <RoundBar />
          {data.exhausted ? (
            <Exhausted mode={search.mode ?? 'recommend'} />
          ) : (
            // 🔴 **読み込むたびに中身ごと作り直す**（レビュー `OCL-5AC2D54A`）。
            // 盤・手順・判定を state に持って進める画面なので、loader だけ走らせると前の問題が残る。
            // 次の問題・入口の切り替え・戻るボタンのどれも loader を通るので、ここ 1 か所で揃う
            <DrillRunner key={data.load} initial={data} search={search} />
          )}
        </>
      )}
    </div>
  );
}

type Counts = NonNullable<Awaited<ReturnType<typeof loadCounts>>['counts']>;

/**
 * ホーム（prd/13 §7.5）。入口のカード 4 つと問題の一覧へのリンクだけ。
 * 🔒 **正答率などの成績は出さない**（§10。棋力の向上に繋がらないため）
 */
function DrillHome({ counts, error }: { counts: Counts | null; error: string | null }) {
  if (error || !counts) return <p className="text-error p-2">{error ?? '読み込めませんでした'}</p>;
  if (counts.total === 0) {
    return (
      <p className="text-base-content/70 p-2">
        まだ問題がありません。解析済みの棋譜が増えると問題が作られます。
      </p>
    );
  }
  const entries: { mode: DrillMode; stock: number; detail: string }[] = [
    { mode: 'recommend', stock: counts.recommend, detail: '間違えた問題・新しい対局の問題から' },
    { mode: 'mate', stock: counts.mate, detail: `未解答 ${counts.mate}` },
    { mode: 'best', stock: counts.best, detail: `未解答 ${counts.best}` },
    { mode: 'wrong', stock: counts.wrong, detail: `${counts.wrong} 問` },
  ];
  return (
    <div className="space-y-3 max-w-xl">
      <h1 className="text-lg font-bold">出題</h1>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {entries.map(({ mode, stock, detail }) =>
          // 在庫が 0 の入口は押せない形で出す（数が 0 と分かれば足りる）
          stock > 0 ? (
            <Link
              key={mode}
              to="/drills"
              search={modeSearch(mode)}
              className="card card-border bg-base-100 hover:bg-base-200 p-4"
            >
              <span className="font-bold text-base">{MODE_LABEL[mode]}</span>
              <span className="text-sm text-base-content/70">{detail}</span>
            </Link>
          ) : (
            <div
              key={mode}
              aria-disabled="true"
              className="card card-border bg-base-200/50 p-4 text-base-content/50"
            >
              <span className="font-bold text-base">{MODE_LABEL[mode]}</span>
              <span className="text-sm">{mode === 'recommend' ? 'いま出せる問題はありません' : detail}</span>
            </div>
          ),
        )}
      </div>
      <Link to="/drills" search={{ view: 'list' }} className="link link-primary text-sm">
        問題の一覧
      </Link>
    </div>
  );
}

type DrillListData = NonNullable<Awaited<ReturnType<typeof loadList>>['list']>;

/** 問題の一覧（カード。prd/13 §7.7）。絞り込みは状態・種類 */
function DrillListScreen({
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
    try {
      const res = await client.api.drills[':kifuNo'][':moveNumber'][':kind'].unexclude.$post({
        param: refParam(ref),
      });
      if (!res.ok) {
        setActionError(`除外を取り消せませんでした (${res.status})`);
        return;
      }
      setActionError(null);
      await router.invalidate();
    } catch {
      setActionError('サーバーに接続できません');
    }
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

/** 解く画面の上部: 「この回 N 問中 M 問正解」と「ホーム」（prd/13 §7.6） */
function RoundBar() {
  const round = useSyncExternalStore(drillRound.subscribe, drillRound.get, () => null);
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-base-content/70">{roundText(round)}</span>
      <Link to="/drills" className="btn btn-sm btn-ghost ms-auto">
        ホーム
      </Link>
    </div>
  );
}

/** 入口の在庫が尽きた（prd/13 §6.4）。ほかの入口とホームへの導線を出す */
function Exhausted({ mode }: { mode: DrillMode }) {
  return (
    <div className="space-y-3 p-2">
      <p>この入口の問題はもうありません。</p>
      <div className="flex items-center gap-2 flex-wrap">
        {MODES.filter((other) => other !== mode).map((other) => (
          <Link key={other} to="/drills" search={modeSearch(other)} replace className="btn btn-sm">
            {MODE_LABEL[other]}
          </Link>
        ))}
        <Link to="/drills" className="btn btn-sm btn-ghost">
          ホーム
        </Link>
      </div>
    </div>
  );
}

/** 解答後に server が明かす情報（prd/13 §5.3） */
interface Reveal {
  verdict: 'correct' | 'close' | 'wrong';
  lossCp: number | null;
  refutation?: string[];
  /** 棋譜の番号（所有者ごと。prd/14 §4.4） */
  kifuNo: number;
  moveNumber: number;
  reason: 'missed_mate' | 'own_blunder';
  answerMove: string;
  answerPv: string[] | null;
  playedMove: string | null;
  playedLossCp: number | null;
  /** ユーザーの手順の手数（詰将棋の詰み上がりに出す） */
  plies: number;
  /** 当初の正解手順の手数 */
  answerPlies: number | null;
  /** 「答えを見る」で出した結果 */
  gaveUp?: boolean;
}

/** 解答後の表示に要る、画面側の事情（練習で解いたか・記録済みの判定） */
interface Shown extends Reveal {
  practice: boolean;
  recorded: Reveal['verdict'] | null;
}

/** 詰将棋で間違えた手の案内（その手は盤から取り消してある） */
interface Miss {
  reason: MissReason;
  /** 咎め筋（受けの手）。日本語にして持つ（読む局面は取り消す前の盤） */
  refutationText: string | null;
}

/** ポーリングの間隔と総予算。server の期限（最大 240 秒）に合わせて切る（prd/12 §2.4） */
const POLL_INTERVAL_MS = 1500;
const POLL_BUDGET_MS = 240_000;

function DrillRunner({ initial, search }: { initial: SolveData; search: DrillsSearch }) {
  const { scoring } = useDrillScoring();
  const navigate = useNavigate({ from: '/drills' });
  /** 入ってきた入口。一覧から名指しで開いた問題は null（大きいボタンが「一覧に戻る」になる。prd/13 §7.6） */
  const mode = search.mode ?? null;

  // 読み込むたびに `key` で作り直す（呼び出し側）ので、ここで差し替えることはない
  const [drill] = useState<Drill | null>(initial.drill);
  const [error, setError] = useState<string | null>(initial.error);
  /** 出題局面からの確定した手順（受方の応手を含む。prd/13 §5.3） */
  const [line, setLine] = useState<string[]>([]);
  const [session, setSession] = useState<StudySession | null>(() => sessionOf(initial.drill, []));
  const [reveal, setReveal] = useState<Shown | null>(null);
  const [judging, setJudging] = useState(false);
  /** 詰将棋で間違えた手の案内（次の操作で消える） */
  const [miss, setMiss] = useState<Miss | null>(null);
  /**
   * この問題で記録した判定（prd/13 §6.2）。🔒 **記録は 1 問 1 回**——最初に間違えた・答えを見た・解き終えた時点で
   * 決まり、以後の操作（続けて詰ませる・1 手戻す・最初から・解答後のやり直し）は練習（`practice`）で送る
   */
  const [recorded, setRecorded] = useState<Reveal['verdict'] | null>(null);
  /** 「答えを見る」の 1 段目を押した（画面内の 2 段の確認。`confirm()` は使わない） */
  const [confirmGiveUp, setConfirmGiveUp] = useState(false);
  /** この端末のエンジンで採点できなかった（同意の前・解析できない環境など）。案内（同意のボタンなど）も並べて出す */
  const [ungradable, setUngradable] = useState(false);

  /**
   * 解いた後の大きいボタン。🔒 **次の問題も loader に選ばせる**（prd/13 §7.8）——問題の指定を落として replace で
   * 移ると、loader が入口の次の 1 問を選んで URL に載せ直す（履歴は積まない）。**取得は loader が持つ**
   */
  function onNext() {
    if (mode) navigate({ search: modeSearch(mode), replace: true });
    else navigate({ search: listSearch(search) });
  }

  /** 記録した解答を「この回」に数える（記録は 1 問 1 回。練習は数えない。prd/13 §7.6） */
  function noteRecorded(verdict: Reveal['verdict']) {
    setRecorded(verdict);
    drillRound.record(verdict);
  }

  const base = drill ? parseSfen(drill.sfen) : null;
  const state = session ? currentState(session) : base;
  // ⚠ **解いている側を下に置く**（自分の手番の局面しか出題されない。prd/13 §4.1）
  const flipped = base?.sideToMove === 'gote';
  /** 確定前の 1 手（盤で動かしたが、まだ答えていない手） */
  const pending = session && session.steps.length > line.length + 1 ? lastMove(session) : null;


  /**
   * 盤を叩く。🔒 **盤操作は「ルールどおり」のモード**（`lib/study.ts`）——手番側の駒だけ選べ、
   * 行き先は駒の動き方の中だけ（レビュー `OCL-1A2B07B9`。server の `validateMoveOnPosition` は
   * 駒の動き方を見ないので、塗るだけだと歩を横に動かす手がエンジンまで届く）。
   * 盤の駒を選択中に駒台を叩いても駒台へは移らず、持ち駒の選択に切り替わる（prd/13 §7.1）。
   * ⚠ 検討盤は自由編集のまま——**出題だけの規則**。
   */
  function onSquare(square: SquareRef) {
    if (!session || reveal || judging || pending) return;
    setSession(tapSquare(session, square));
  }

  function onHand(kind: HandPieceKind) {
    if (!session || reveal || judging || pending) return;
    setSession(tapHand(session, currentState(session).sideToMove, kind));
  }

  /** 確定した手順まで盤を戻す（間違えた手・確定前の手を捨てる） */
  function resetTo(next: string[]) {
    setLine(next);
    setSession(sessionOf(drill, next));
    setMiss(null);
    setError(null);
    setUngradable(false);
    setConfirmGiveUp(false);
  }

  /** 最初から（出題局面へ）。解答後も押せる——以後は練習（記録しない） */
  function restart() {
    resetTo([]);
    setReveal(null);
  }

  /** 1 手戻す（詰将棋。受方の応手と自分の手の 2 手ぶん） */
  function undoTurn() {
    const next = lineAfterUndoTurn(line);
    if (next) resetTo(next);
  }

  /** 答えを見る（諦め）。記録は不正解（記録済みなら練習） */
  async function giveUp() {
    if (!drill) return;
    const practice = recorded !== null;
    setConfirmGiveUp(false);
    setJudging(true);
    setError(null);
    try {
      const res = await client.api.drills[':kifuNo'][':moveNumber'][':kind']['give-up'].$post({
        param: refParam(drill),
        // 確定した手順だけ送る（確定前の手は捨てる）
        json: { line, practice },
      });
      const step = answerStepOf<Reveal>(res.status, await res.json().catch(() => null));
      if (step.kind !== 'done') {
        setError(step.kind === 'error' ? step.text : `サーバーエラー (${res.status})`);
        return;
      }
      const nextRecorded = practice ? recorded : step.result.verdict;
      if (!practice) noteRecorded(step.result.verdict);
      setSession(sessionOf(drill, line));
      setMiss(null);
      setReveal({ ...step.result, practice, recorded: nextRecorded });
    } catch {
      setError('サーバーに接続できません');
    } finally {
      setJudging(false);
    }
  }

  async function answer(move: string) {
    if (!drill || !session) return;
    setJudging(true);
    setError(null);
    setUngradable(false);
    setMiss(null);
    setConfirmGiveUp(false);
    const practice = recorded !== null;
    /** 答えた手を指した後の局面（咎め筋はここから読む） */
    const answered = currentState(session);
    let body: AnswerBody = { line: [...line, move], ...scoring, ...(practice ? { practice: true } : {}) };
    let deadline = Date.now() + POLL_BUDGET_MS;
    try {
      while (Date.now() < deadline) {
        const res = await client.api.drills[':kifuNo'][':moveNumber'][':kind'].answer.$post({
          param: refParam(drill),
          json: body,
        });
        // ⚠ **本文のパースはステータス判定より後**（前段が返す HTML で落ちると、
        // 通信断でもないのに「接続できません」と出る。prd/12 §2.4）
        const step = answerStepOf<Reveal>(res.status, await res.json().catch(() => null));
        switch (step.kind) {
          case 'wait-job':
            await waitForEvaluation(step.jobId, deadline);
            continue;
          case 'evaluate': {
            // 🔒 読んだ結果を付けて送り直したのに、また読んでと返る ＝ 噛み合っていない。回り続けない
            if (body.evaluation) {
              setError('判定できませんでした。もう一度お試しください');
              setJudging(false);
              return;
            }
            // このブラウザのエンジンで名指しで読む（全局面解析より先に。prd/14 §5.10）
            const graded = await requestBrowserGrading(step.request, {
              getPhase: () => getBrowserAnalysisState().phase,
              subscribe: subscribeBrowserAnalysisState,
              setTimeout: (callback, ms) => setTimeout(callback, ms),
              clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
            });
            if (graded.kind !== 'ok') {
              setError(gradingFailureMessage(graded));
              setUngradable(graded.kind === 'unavailable');
              setJudging(false);
              return;
            }
            body = answerBodyWithEvaluation(body, graded.evaluation);
            // エンジンの準備（初回のダウンロード）に掛かった時間は、送り直しの待ちに数えない
            deadline = Date.now() + POLL_BUDGET_MS;
            continue;
          }
          case 'error':
            setError(step.text);
            setJudging(false);
            return;
          case 'continue': {
            // 詰みの指し継ぎ。受方の応手まで進めて次の手を待つ（prd/13 §5.2）
            const advanced = [...line, move, step.reply];
            setLine(advanced);
            setSession(sessionOf(drill, advanced));
            setJudging(false);
            return;
          }
          case 'miss': {
            // 詰将棋で間違えた。**その手を取り消して同じ局面で考え直す**（prd/13 §5.2）。
            // 記録は最初の間違いの 1 回（server が記録済み）。以後は練習で送る
            if (!practice) noteRecorded('wrong');
            setMiss({
              reason: step.reason,
              refutationText: step.refutation.length > 0 ? movesText(answered, step.refutation) : null,
            });
            setSession(sessionOf(drill, line));
            setJudging(false);
            return;
          }
          case 'done': {
            const nextRecorded = practice ? recorded : step.result.verdict;
            if (!practice) noteRecorded(step.result.verdict);
            setReveal({ ...step.result, practice, recorded: nextRecorded });
            setJudging(false);
            return;
          }
        }
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
    await client.api.drills[':kifuNo'][':moveNumber'][':kind'].exclude.$post({
      param: refParam(drill),
    });
    onNext();
  }

  if (error && !drill) {
    return <p className="text-error p-2">{error}</p>;
  }
  if (!drill || !state) {
    return <p className="text-base-content/70 p-2">この問題を表示できません。</p>;
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
        destinations={selectionDestinations(session)}
      />
      <HandDisplay
        hand={state.hand[flipped ? 'gote' : 'sente']}
        side={flipped ? 'gote' : 'sente'}
        flipped={flipped}
        onPieceClick={reveal || judging ? undefined : onHand}
        selected={session?.selection?.kind === 'hand' ? session.selection.piece : null}
      />

      {error && <p className="text-error text-sm">{error}</p>}
      {/*
        このブラウザで読むときの案内（初回のダウンロードの進捗・同意のボタン・止まったときのやり直し）。
        サーバーで解析する利用者では何も出ない
      */}
      {(judging || ungradable) && <BrowserAnalysisNotice />}

      {judging && (
        <p className="text-sm text-base-content/70">
          <span className="loading loading-spinner loading-xs align-middle mr-1" />
          判定しています
        </p>
      )}

      {miss && !reveal && !judging && (
        <div className="alert alert-warning py-2 text-sm flex flex-col items-start gap-1">
          <span>{missText(miss.reason)}。その手を取り消しました</span>
          {miss.refutationText && <span className="break-all">咎め筋 {miss.refutationText}</span>}
        </div>
      )}

      {pending && !reveal && !judging && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm">
            {usiToJapaneseWithPiece(session!.steps[session!.cursor - 1].state, pending)}
          </span>
          {/*
            🔒 **成れる手のときだけ「成」を出す。** 自由編集の `canTogglePromotion` は打った駒まで
            成らせるため、そのままだと**押せるのに server が 400（illegal_promotion）を返すボタン**ができる。
            「ルールどおり」のモードは `shared` の `canPromoteMove`（server の検証と同じ出所）で絞る（`lib/study.ts`）。
          */}
          {canTogglePromotion(session!) && (
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

      {!reveal && !judging && (
        // 🔒 「この手で答える」から離して控えめに置く（prd/13 §7.1）
        <div className="flex items-center gap-2 flex-wrap pt-2 border-t border-base-300">
          {drill.kind === 'mate' && (
            <>
              <button
                type="button"
                className="btn btn-xs btn-ghost"
                disabled={lineAfterUndoTurn(line) === null}
                onClick={undoTurn}
              >
                1 手戻す
              </button>
              <button
                type="button"
                className="btn btn-xs btn-ghost"
                disabled={line.length === 0 && !pending}
                onClick={restart}
              >
                最初から
              </button>
            </>
          )}
          {!confirmGiveUp && (
            <button
              type="button"
              className="btn btn-xs btn-ghost ms-auto"
              onClick={() => setConfirmGiveUp(true)}
            >
              答えを見る
            </button>
          )}
          {confirmGiveUp && (
            // 確認の 2 ボタンだけを 1 行に並べる（スマホ幅で「やめる」が次の行に落ちないように）
            <div className="flex items-center gap-2 flex-nowrap w-full justify-end">
              <button type="button" className="btn btn-xs btn-outline btn-error" onClick={giveUp}>
                本当に答えを見る（不正解になります）
              </button>
              <button type="button" className="btn btn-xs btn-ghost" onClick={() => setConfirmGiveUp(false)}>
                やめる
              </button>
            </div>
          )}
        </div>
      )}

      {reveal && (
        <Result
          reveal={reveal}
          drill={drill}
          base={base!}
          // 咎め筋は**答えた手を指した後**の局面から読む（相手の応手から始まるため）
          answered={state}
          mode={mode}
          onNext={onNext}
          onExclude={exclude}
          onRestart={restart}
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
  mode,
  onNext,
  onExclude,
  onRestart,
}: {
  reveal: Shown;
  drill: Drill;
  base: BoardState;
  /** 答えた手を指した後の局面（咎め筋の読み出しに使う） */
  answered: BoardState;
  /** 入ってきた入口（一覧から開いた問題は null） */
  mode: DrillMode | null;
  /** 大きいボタン（入口の次の問題 / 一覧に戻る） */
  onNext: () => void;
  onExclude: () => void;
  /** 最初から解き直す（練習。記録しない） */
  onRestart: () => void;
}) {
  const verdict = resultBadge(drill.kind, reveal.verdict, reveal.practice);
  const note = practiceNote(reveal.practice, reveal.recorded);
  return (
    <div className="card bg-base-200 p-3 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`badge ${verdict.className}`}>{verdict.label}</span>
        {reveal.lossCp !== null && (
          <span className="text-sm">損失 {reveal.lossCp}cp</span>
        )}
        {drill.kind === 'mate' && reveal.verdict === 'correct' && (
          <span className="text-sm">{matePliesText(reveal.plies, reveal.answerPlies)}</span>
        )}
        {reveal.gaveUp && <span className="text-sm text-base-content/70">答えを見ました</span>}
        <span className="text-sm">
          正解 {usiToJapaneseWithPiece(base, reveal.answerMove)}
        </span>
      </div>
      {note && <p className="text-xs text-base-content/60">{note}</p>}

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

      {/* 解いた後のボタン（prd/13 §7.6）。上から: 入口の続き（大）→ 入口の切り替え → その他 */}
      <button type="button" className="btn btn-primary btn-block" onClick={onNext}>
        {mode ? `次の問題（${MODE_LABEL[mode]}）` : '一覧に戻る'}
      </button>
      <div className="flex items-center gap-2 flex-wrap">
        {/* 今の入口と同じになるものは出さない */}
        {(['mate', 'best'] as const)
          .filter((other) => other !== mode)
          .map((other) => (
            <Link key={other} to="/drills" search={modeSearch(other)} replace className="btn btn-sm flex-1">
              次は{MODE_LABEL[other]}
            </Link>
          ))}
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        {/*
          元の対局。出題局面の**次の手**（＝この問題の手）まで進めた状態で開く。
          `moveNumber` は 0 始まりの指し手番号なので、盤の手数（初期局面からの手数）は +1。
          こうすると開いた瞬間にその手の評価値・候補手が出る（prd/13 §7.1）
        */}
        <Link
          to="/kifus/$id"
          params={{ id: String(reveal.kifuNo) }}
          search={{ ply: reveal.moveNumber + 1 }}
          className="btn btn-sm btn-ghost"
        >
          元の対局
        </Link>
        {/* やり直す（§7.1 の解答後の「最初から」。以後は練習で記録しない） */}
        <button type="button" className="btn btn-sm btn-ghost" onClick={onRestart}>
          やり直す
        </button>
        {/* 🔒 自動判定は作らない（「取り返し」の定義から詰まる。prd/13 §4.2） */}
        <button type="button" className="btn btn-sm btn-ghost" onClick={onExclude}>
          自明だった
        </button>
        <Link to="/drills" className="btn btn-sm btn-ghost">
          ホーム
        </Link>
      </div>

      <AttemptsOf drill={drill} />
    </div>
  );
}

/**
 * この問題の解答履歴（prd/13 §7.7）。🔒 **解いた後にだけ出す**（`Result` の中だけで使う）——
 * 正解の記録の「指した手」は答えそのもの。解いた直後の記録も入るよう、解答後の表示が出るたびに引く
 */
function AttemptsOf({ drill }: { drill: Drill }) {
  const [rows, setRows] = useState<DrillAttemptRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { kifuNo, moveNumber, kind } = drill;
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await client.api.drills[':kifuNo'][':moveNumber'][':kind'].attempts.$get({
          param: refParam({ kifuNo, moveNumber, kind }),
        });
        if (!res.ok) throw new Error(String(res.status));
        const body = await res.json();
        if (!cancelled) setRows(body.attempts);
      } catch {
        if (!cancelled) setError('解答履歴を読み込めませんでした');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [kifuNo, moveNumber, kind]);
  return (
    <details className="pt-2 border-t border-base-300">
      <summary className="text-sm cursor-pointer">この問題の解答履歴</summary>
      <div className="pt-1">
        {error && <p className="text-error text-sm">{error}</p>}
        {rows && <DrillAttemptHistory rows={rows} />}
        {!rows && !error && <span className="loading loading-spinner loading-xs" />}
      </div>
    </details>
  );
}

/** 出題局面 + 確定した手順からセッションを作る */
function sessionOf(drill: Drill | null, line: string[]): StudySession | null {
  if (!drill) return null;
  const base = parseSfen(drill.sfen);
  // 🔒 出題の盤は「ルールどおり」（`lib/study.ts`。prd/13 §7.1）
  return base ? applyStudyMoves(base, line, 'rules') : null;
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


