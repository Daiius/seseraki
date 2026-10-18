import { useState } from 'react';
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
import { DrillHistory, DrillList } from '../components/DrillTables';
import { BrowserAnalysisNotice } from '../components/BrowserAnalysis';
import { answerBodyWithEvaluation, answerStepOf, type AnswerBody } from '../lib/drillAnswer';
import { gradingFailureMessage, requestBrowserGrading } from '../lib/browserAnalysis/grading';
import {
  getBrowserAnalysisState,
  subscribeBrowserAnalysisState,
} from '../lib/browserAnalysis/store';
import {
  drillRefOf,
  nextDrillSearch,
  option,
  pinnedSearch,
  STATUSES,
  validateDrillsSearch,
  VERDICTS,
  type DrillRef,
  type DrillsSearch,
} from '../lib/drillSearch';

/**
 * 出題（prd/13）。溜め込んだ棋譜と解析から作った問題を解く。
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
    handler: ({ deps }) => loadTab(deps),
    // 🔒 **読み直しを裏で走らせない**（prd/13 §7.4）。既定の stale-while-revalidate だと、
    // 戻るボタンで**古い読み込み結果を描いたあとに**新しい結果が届き、解きかけの盤が
    // 作り直される（`key` が読み込みごとに変わるため）。待ってから 1 度だけ描く
    staleReloadMode: 'blocking',
  },
  component: DrillsPage,
});

type SolveResponse = Awaited<ReturnType<typeof loadNext>>;
type Drill = NonNullable<SolveResponse['drill']>;

/**
 * 解くタブの読み込みの通し番号。**読み込むたびに盤を作り直す**ための `key`。
 * ⚠ 問題（棋譜の番号・手数・種類）だけを `key` にすると、「次の問題」で**同じ問題がまた選ばれた**とき
 * （出題順は段の中でランダム。prd/13 §6.3）に作り直されず、解答後の表示が残る
 */
let solveLoads = 0;

/** タブごとに引くものが違う（prd/13 §7.4）。**タブは URL の検索パラメータ**なので loader で分ける */
async function loadTab(search: DrillsSearch) {
  if (search.tab === 'list') return { tab: 'list' as const, ...(await loadList(search)) };
  if (search.tab === 'history') return { tab: 'history' as const, ...(await loadHistory(search)) };
  const ref = drillRefOf(search);
  if (ref) {
    return { tab: 'solve' as const, load: ++solveLoads, ...(await loadOne(ref)) };
  }
  const next = await loadNext(search.kind);
  // 🔒 **選んだ問題を URL に載せる**（prd/13 §7.4）。載せないと、棋譜詳細から戻ったときに
  // loader が**別の問題を選び直す**。loader の redirect は router が **replace** で扱うので
  // 履歴は積まれない。置き換え先は問題を指すので 2 度目は `loadOne` に入り、ループしない
  // ⚠ 取得は 2 回になる（next → 名指し）が、**取得経路を loader の 1 本に保つ**方を取る
  const pinned = next.drill ? pinnedSearch(search, refOf(next.drill)) : null;
  if (pinned) throw redirect({ to: '/drills', search: pinned });
  return { tab: 'solve' as const, load: ++solveLoads, ...next };
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

/** 一覧から名指しで開いた 1 問（prd/13 §5.4）。返る形は `/drills/next` と同じ */
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
  /** 棋譜の番号（所有者ごと。prd/14 §4.4） */
  kifuNo: number;
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

  async function unexclude(ref: DrillRef) {
    // 🔴 **応答を確かめてから引き直す**（レビュー `OCL-63C7DD79`）。POST だけが失敗して
    // GET が成功すると、**除外されたままの一覧が普通に描き直される**——押した側からは
    // 「効かなかった」ことも理由も分からない
    try {
      const res = await client.api.drills[':kifuNo'][':moveNumber'][':kind'].unexclude.$post({
        param: refParam(ref),
      });
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
        // 🔴 **読み込むたびに中身ごと作り直す**（レビュー `OCL-5AC2D54A`）。
        // 盤・手順・判定を state に持って進める画面なので、loader だけ走らせると前の問題が残る。
        // 種類の切り替え・次の問題・戻るボタンのどれも loader を通るので、ここ 1 か所で揃う
        <DrillRunner
          key={data.load}
          initial={data}
          // 🔒 **次の問題も loader に選ばせる**（prd/13 §7.4）。問題を指す組を落として replace で
          // 移ると、loader が次の 1 問を選んで URL に載せ直す（履歴は積まない）
          onNext={() => navigate({ search: nextDrillSearch, replace: true })}
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
            search={{
              ...search,
              kind: value,
              page: undefined,
              kifu: undefined,
              ply: undefined,
              drillKind: undefined,
            }}
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
  onNext,
}: {
  initial: SolveResponse;
  /** 次の問題へ進む。**取得は loader が持つ**ので、ここは URL を変えるだけ（prd/13 §7.4） */
  onNext: () => void;
}) {
  const { scoring } = useDrillScoring();
  // 読み込むたびに `key` で作り直す（呼び出し側）ので、ここで差し替えることはない
  const [drill] = useState<Drill | null>(initial.drill);
  const [error, setError] = useState<string | null>(initial.error);
  /** 出題局面からの確定した手順（受方の応手を含む。prd/13 §5.3） */
  const [line, setLine] = useState<string[]>([]);
  const [session, setSession] = useState<StudySession | null>(() => sessionOf(initial.drill, []));
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [judging, setJudging] = useState(false);
  /** この端末のエンジンで採点できなかった（同意の前・解析できない環境など）。案内（同意のボタンなど）も並べて出す */
  const [ungradable, setUngradable] = useState(false);

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

  async function answer(move: string) {
    if (!drill) return;
    setJudging(true);
    setError(null);
    setUngradable(false);
    let body: AnswerBody = { line: [...line, move], ...scoring };
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
          case 'done':
            setReveal(step.result);
            setJudging(false);
            return;
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

      {reveal && (
        <Result
          reveal={reveal}
          drill={drill}
          base={base!}
          // 咎め筋は**答えた手を指した後**の局面から読む（相手の応手から始まるため）
          answered={state}
          onNext={onNext}
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
          params={{ id: String(reveal.kifuNo) }}
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


