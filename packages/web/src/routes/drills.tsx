import { useEffect, useState, useSyncExternalStore } from 'react';
import { createFileRoute, Link, redirect, useNavigate, useRouter } from '@tanstack/react-router';
import {
  parseSfen,
  pieceAt,
  usiToJapaneseWithPiece,
  type BoardState,
  type HandPieceKind,
  type SquareRef,
} from 'shared';
import { client } from '../lib/honoClient';
import { BoardGrid, HandDisplay, type PromotionChoice } from '../components/BoardGrid';
import {
  applyStudyMoves,
  currentState,
  lastMove,
  promotionNeedOf,
  selectionDestinations,
  squareOfUsi,
  tapHand,
  tapSquare,
  withPromotion,
  type StudySession,
} from '../lib/study';
import { useDrillScoring } from '../lib/drillScoring';
import { DrillAttemptHistory, DrillCardList, type DrillAttemptRow } from '../components/DrillCards';
import {
  BrowserAnalysisNotice,
  DrillEngineConsent,
  DrillGradingHost,
} from '../components/BrowserAnalysis';
import {
  answerBodyUnavailable,
  answerBodyWithEvaluation,
  answerStepOf,
  onEvaluate,
  lineAfterUndoTurn,
  matePliesText,
  missText,
  practiceNote,
  resultBadge,
  engineWaitFromOf,
  retriesAfterEngineReady,
  type AnswerBody,
  type MissReason,
} from '../lib/drillAnswer';
import {
  gradingFailureMessage,
  requestBrowserGrading,
  type GradingResult,
} from '../lib/browserAnalysis/grading';
import {
  getBrowserAnalysisState,
  subscribeBrowserAnalysisState,
  useBrowserAnalysisState,
  type BrowserAnalysisPhase,
} from '../lib/browserAnalysis/store';
import { askDrillEngineConsent, requestDrillEngine } from '../lib/browserAnalysis/drillEngine';
import { useAnalysisAssignee } from '../lib/useMe';
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
import {
  ArrowRestartIcon,
  BookOpenIcon,
  ChevronDownIcon,
  DrillModeIcon,
  EyeSlashIcon,
  HomeIcon,
} from '../components/icons';
import { ICON_BTN, MENU_ITEM, MENU_LIST } from '../lib/touchTargets';

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
 * 🔒 **詰将棋の判定は担当によらずこのブラウザで読む**（prd/13 §5.5）。サーバーで解析する利用者には、初めて詰将棋の 1 手を
 * 指したときに判定だけのエンジンを用意し（同意を求める）、読めなければ「読めない」と申告して送り直す（サーバーで判定される）。
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
    const one = await loadOne(ref);
    // 🔴 **名指しで開いた問題でも、解答より前に回の開始時刻を決める**（レビュー `OCL-BB10F0BB`）。
    // 決めないまま解くと、次の 1 問の取得が since なしで選び、さらに解答後の時刻を開始時刻にするので、
    // この回で解いた問題がまた出る（保存した URL を新しいタブで開いた・一覧から開いたとき）
    if (one.now && !preload) drillRound.startAt(one.now);
    return {
      screen: 'solve' as const,
      load: ++solveLoads,
      exhausted: false,
      drill: one.drill,
      error: one.error,
    };
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
    if (res.status === 404) return { drill: null, now: null, error: '出題が見つかりません' };
    if (!res.ok) return { drill: null, now: null, error: `サーバーエラー (${res.status})` };
    const body = await res.json();
    return { drill: body.drill, now: body.now, error: null };
  } catch {
    return { drill: null, now: null, error: 'サーバーに接続できません' };
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
  const assignee = useAnalysisAssignee();
  return (
    <div className="p-2 space-y-2">
      {/* 詰将棋の判定だけのエンジン（サーバーで解析する利用者。prd/13 §5.5）。問題をまたいで使い回し、出題の画面を離れたら止める */}
      <DrillGradingHost enabled={assignee === 'worker'} />
      {data.screen === 'home' && <DrillHome counts={data.counts} error={data.error} />}
      {data.screen === 'list' && <DrillListScreen list={data.list} error={data.error} search={search} />}
      {data.screen === 'solve' && (
        <>
          {data.exhausted ? (
            <>
              <RoundBar />
              <Exhausted mode={search.mode ?? 'recommend'} />
            </>
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
              className="card card-border bg-base-100 hover:bg-base-200 p-4 flex-row items-center gap-3"
            >
              {/* 入口のアイコン（解いた後のボタン・ドロップダウンと同じ。prd/13 §7.5） */}
              {/* 幅を揃える（おすすめの重ねた駒は横に広い）——名前の書き出しが入口ごとにずれないように */}
              <span className="font-bold text-base w-9 shrink-0 flex justify-center">
                <DrillModeIcon mode={mode} />
              </span>
              <span className="flex flex-col">
                <span className="font-bold text-base">{MODE_LABEL[mode]}</span>
                <span className="text-sm text-base-content/70">{detail}</span>
              </span>
            </Link>
          ) : (
            <div
              key={mode}
              aria-disabled="true"
              className="card card-border bg-base-200/50 p-4 text-base-content/50 flex-row items-center gap-3"
            >
              {/* 幅を揃える（おすすめの重ねた駒は横に広い）——名前の書き出しが入口ごとにずれないように */}
              <span className="font-bold text-base w-9 shrink-0 flex justify-center">
                <DrillModeIcon mode={mode} />
              </span>
              <span className="flex flex-col">
                <span className="font-bold text-base">{MODE_LABEL[mode]}</span>
                <span className="text-sm">{mode === 'recommend' ? 'いま出せる問題はありません' : detail}</span>
              </span>
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

/**
 * 解く画面の上部: 「この回 N 問中 M 問正解」と、右端のケバブ（prd/13 §7.6）。
 * ケバブにはホーム・元の対局・やり直す・自明だったをアイコン付きで入れる（問題が無い画面ではホームだけ）
 */
function RoundBar({ solve }: { solve?: SolveActions }) {
  const round = useSyncExternalStore(drillRound.subscribe, drillRound.get, () => null);
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-base-content/70">{roundText(round)}</span>
      <div className="ms-auto">
        <SolveMenu solve={solve} />
      </div>
    </div>
  );
}

type SolveActions = {
  kifuNo: number;
  moveNumber: number;
  /**
   * 採点中（判定の応答待ち）。🔴 **やり直す・自明だったを押させない**（レビュー `OCL-D7C87C9C`）——
   * 進行中の採点の応答が、やり直した後の盤に古い手順や結果を書き戻してしまう
   */
  judging: boolean;
  onRestart: () => void;
  onExclude: () => void;
};

/**
 * 解く画面のケバブ。元の対局・やり直す・自明だったは**解く前から押せる**（2026-10-29 決定）。
 * ⚠ 解く前の「元の対局」は答えが見えている画面へ移る（§7.1 で伏せている棋譜を自分で開く）。記録は付かない
 */
function SolveMenu({ solve }: { solve?: SolveActions }) {
  // daisyUI の dropdown はフォーカスで開閉するので、項目を押したらフォーカスを外して閉じる（kifus/$id と同じ）
  const closeMenu = () => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  };
  return (
    <div className="dropdown dropdown-end">
      <button tabIndex={0} className={ICON_BTN} aria-label="メニュー">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={2}
          stroke="currentColor"
          className="size-5"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.75a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5ZM12 12.75a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5ZM12 18.75a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5Z" />
        </svg>
      </button>
      <ul tabIndex={0} className={`${MENU_LIST} w-40`}>
        <li>
          <Link to="/drills" className={MENU_ITEM}>
            <HomeIcon />
            ホーム
          </Link>
        </li>
        {solve && (
          <>
            <li>
              {/*
                元の対局。出題局面の**次の手**（＝この問題の手）まで進めた状態で開く。
                `moveNumber` は 0 始まりの指し手番号なので、盤の手数（初期局面からの手数）は +1。
                こうすると開いた瞬間にその手の評価値・候補手が出る（prd/13 §7.1）
              */}
              <Link
                to="/kifus/$id"
                params={{ id: String(solve.kifuNo) }}
                search={{ ply: solve.moveNumber + 1 }}
                className={MENU_ITEM}
              >
                <BookOpenIcon />
                元の対局
              </Link>
            </li>
            <li>
              {/* やり直す（§7.1 の「最初から」。解答後なら以後は練習で記録しない） */}
              <button
                type="button"
                className={MENU_ITEM}
                disabled={solve.judging}
                onClick={() => {
                  closeMenu();
                  solve.onRestart();
                }}
              >
                <ArrowRestartIcon />
                やり直す
              </button>
            </li>
            <li>
              {/* 🔒 自動判定は作らない（「取り返し」の定義から詰まる。prd/13 §4.2） */}
              <button
                type="button"
                className={MENU_ITEM}
                disabled={solve.judging}
                onClick={() => {
                  closeMenu();
                  solve.onExclude();
                }}
              >
                <EyeSlashIcon />
                自明だった
              </button>
            </li>
          </>
        )}
      </ul>
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
  const assignee = useAnalysisAssignee();
  const enginePhase = useBrowserAnalysisState().phase;
  const engineLoading = enginePhase === 'loading';
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
  /**
   * この端末のエンジンで採点できなかった（同意の前・解析できない環境など）ときの、エンジンの状態。案内（同意のボタンなど）も並べて出す。
   * 答えた手は盤に残し、エンジンが使えるようになったら同じ手で判定し直す（prd/13 §7.1・2026-10-29）
   */
  const [ungradableAt, setUngradableAt] = useState<BrowserAnalysisPhase | null>(null);
  /** 任意成りの手を指して、盤の上で成 / 不成を選んでいる（prd/13 §7.1・2026-10-29） */
  const [choosing, setChoosing] = useState(false);

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
  /**
   * 確定前の 1 手（盤で動かしたが、まだ判定が済んでいない手）。判定中・成 / 不成を選んでいる間と、
   * エンジンの準備を待つ間（`ungradableAt`）にだけある
   */
  const pending = session && session.steps.length > line.length + 1 ? lastMove(session) : null;

  /**
   * 盤を叩く。🔒 **盤操作は「ルールどおり」のモード**（`lib/study.ts`）——手番側の駒だけ選べ、
   * 行き先は駒の動き方の中だけ（レビュー `OCL-1A2B07B9`。server の `validateMoveOnPosition` は
   * 駒の動き方を見ないので、塗るだけだと歩を横に動かす手がエンジンまで届く）。
   * 盤の駒を選択中に駒台を叩いても駒台へは移らず、持ち駒の選択に切り替わる（prd/13 §7.1）。
   * ⚠ 検討盤は自由編集のまま——**出題だけの規則**。
   *
   * 🔒 **指したら確定のボタンを待たずに判定する**（prd/13 §7.1・2026-10-29。旧仕様の「この手で答える」は廃止）。
   * 任意成りだけ盤の上で成 / 不成を選ばせ、成らなければいけない手は黙って成らせる（`promotionNeedOf`）。
   */
  function onSquare(square: SquareRef) {
    if (!session || reveal || judging) return;
    if (choosing) return cancelChoice();
    played(tapSquare(settledSession(), square));
  }

  function onHand(kind: HandPieceKind) {
    if (!session || reveal || judging) return;
    // 成 / 不成を選んでいる間に駒台を叩いたら、選択肢の外を叩いたのと同じく取り消す
    if (choosing) return cancelChoice();
    const from = settledSession();
    setSession(tapHand(from, currentState(from).sideToMove, kind));
  }

  /**
   * 盤を叩く前のセッション。エンジンの準備を待って盤に残っている手は、**盤を叩いたら捨てる**（指し直す。自動の判定し直しも止まる）
   */
  function settledSession(): StudySession {
    if (!pending) return session!;
    setUngradableAt(null);
    setError(null);
    return sessionOf(drill, line)!;
  }

  /** 叩いた結果。手が 1 つ増えていれば、成り方を決めて判定へ回す */
  function played(next: StudySession) {
    const move = next.steps.length > line.length + 1 ? lastMove(next) : null;
    if (!move) {
      setSession(next);
      return;
    }
    const need = promotionNeedOf(next);
    if (need === 'choose') {
      setSession(next);
      setChoosing(true);
      return;
    }
    submit(need === 'must' ? withPromotion(next, true) : next);
  }

  /** 盤の上の成 / 不成を選んだ */
  function choose(promote: boolean) {
    if (!session) return;
    setChoosing(false);
    submit(withPromotion(session, promote));
  }

  /** 選択肢の外を叩いた。**その手を取り消す**（指す前の局面へ） */
  function cancelChoice() {
    setChoosing(false);
    setSession(sessionOf(drill, line));
  }

  /** 盤の最後の手で答える */
  function submit(next: StudySession) {
    setSession(next);
    void answer(lastMove(next)!, next);
  }

  /** 確定した手順まで盤を戻す（間違えた手・確定前の手を捨てる） */
  function resetTo(next: string[]) {
    setLine(next);
    setSession(sessionOf(drill, next));
    setMiss(null);
    setError(null);
    setUngradableAt(null);
    setChoosing(false);
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
    setChoosing(false);
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

  /** 判定に回す。`at` は答えた手を指した後のセッション（state の反映を待たずに読むので引数で受ける） */
  async function answer(move: string, at: StudySession) {
    if (!drill) return;
    // 🔒 初めて詰将棋の 1 手を指したら、判定のためのエンジンを用意する（同意の前なら同意を求める。prd/13 §5.5）
    if (drill.kind === 'mate') requestDrillEngine();
    setJudging(true);
    setError(null);
    setUngradableAt(null);
    setMiss(null);
    setConfirmGiveUp(false);
    const practice = recorded !== null;
    /** 答えた手を指した後の局面（咎め筋はここから読む） */
    const answered = currentState(at);
    /**
     * 判定できなかった。**その手は盤から戻す**（指し直せるように）。ただしエンジンの準備（同意・ダウンロード）を
     * 待つときだけ盤に残し、準備ができたら同じ手で判定し直す（上の effect）
     */
    const fail = (text: string, waitEngineFrom: BrowserAnalysisPhase | null) => {
      setError(text);
      if (waitEngineFrom !== null) setUngradableAt(waitEngineFrom);
      else setSession(sessionOf(drill, line));
      setJudging(false);
    };
    let body: AnswerBody = { line: [...line, move], ...scoring, ...(practice ? { practice: true } : {}) };
    let deadline = Date.now() + POLL_BUDGET_MS;
    /** このブラウザで読めなかった理由（読めない旨を申告した後、サーバーでも判定されなかったときに出す） */
    let unreadable: Exclude<GradingResult, { kind: 'ok' }> | null = null;
    /**
     * 読めなかった時点のエンジンの状態（判定し直しの基準）。🔴 送り直しの応答を待つ間に同意されても、
     * この値で判定し直す（諦めた時点の状態を使うと、もう使える状態なので二度と判定し直さない。レビュー `OCL-239BA9E5`）
     */
    let unreadableFrom: BrowserAnalysisPhase | null = null;
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
            // 🔒 読んだ結果を付けて送り直したのに、また読んでと返る ＝ 噛み合っていない。回り続けない。
            // 読めないと申告してまた返る ＝ サーバーでも判定できない（ブラウザで解析する利用者）。読めなかった理由を出す
            if (onEvaluate(body) === 'give-up') {
              fail(
                unreadable ? gradingFailureMessage(unreadable) : '判定できませんでした。もう一度お試しください',
                unreadableFrom,
              );
              return;
            }
            // このブラウザのエンジンで名指しで読む（全局面解析より先に。prd/14 §5.10）。
            // サーバーで解析する利用者の詰将棋は、同意の前ならここで同意を待つ（断ったらサーバーで判定する。prd/13 §5.5）
            const graded = await requestBrowserGrading(step.request, {
              getPhase: () => getBrowserAnalysisState().phase,
              subscribe: subscribeBrowserAnalysisState,
              setTimeout: (callback, ms) => setTimeout(callback, ms),
              clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
              ...(assignee === 'worker' && drill.kind === 'mate' ? { askConsent: askDrillEngineConsent } : {}),
            });
            const gradedFrom =
              graded.kind === 'ok' ? null : engineWaitFromOf(graded, getBrowserAnalysisState().phase);
            if (graded.kind !== 'ok' && drill.kind === 'mate') {
              // 詰将棋は「この端末では読めない」と申告して送り直す（サーバーで解析する利用者はサーバーで判定される）
              unreadable = graded;
              unreadableFrom = gradedFrom;
              body = answerBodyUnavailable(body);
              deadline = Date.now() + POLL_BUDGET_MS;
              continue;
            }
            if (graded.kind !== 'ok') {
              fail(gradingFailureMessage(graded), gradedFrom);
              return;
            }
            body = answerBodyWithEvaluation(body, graded.evaluation);
            // エンジンの準備（初回のダウンロード）に掛かった時間は、送り直しの待ちに数えない
            deadline = Date.now() + POLL_BUDGET_MS;
            continue;
          }
          case 'error':
            fail(step.text, null);
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
      fail('判定が終わりませんでした。もう一度お試しください', null);
    } catch {
      fail('サーバーに接続できません', null);
    }
  }

  // エンジンの同意・ダウンロード・やり直しが済んだら、盤に残した手で判定し直す（prd/13 §7.1・2026-10-29）
  useEffect(() => {
    if (ungradableAt === null || !pending || !session || judging) return;
    if (!retriesAfterEngineReady(ungradableAt, enginePhase)) return;
    void answer(pending, session);
  }, [ungradableAt, enginePhase, pending, session, judging]);

  async function exclude() {
    if (!drill) return;
    await client.api.drills[':kifuNo'][':moveNumber'][':kind'].exclude.$post({
      param: refParam(drill),
    });
    onNext();
  }

  if (error && !drill) {
    return (
      <>
        <RoundBar />
        <p className="text-error p-2">{error}</p>
      </>
    );
  }
  if (!drill || !state) {
    return (
      <>
        <RoundBar />
        <p className="text-base-content/70 p-2">この問題を表示できません。</p>
      </>
    );
  }

  return (
    <div className="space-y-2">
      <RoundBar
        solve={{ kifuNo: drill.kifuNo, moveNumber: drill.moveNumber, judging, onRestart: restart, onExclude: exclude }}
      />
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
        promotionChoice={choosing && pending ? promotionChoiceOf(state, pending, choose, cancelChoice) : null}
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
      {assignee === 'browser' ? (
        (judging || ungradableAt !== null) && <BrowserAnalysisNotice />
      ) : (
        // サーバーで解析する利用者: 詰将棋の判定のための同意と、エンジンの準備の進捗だけ（解析の案内は出さない）
        <>
          <DrillEngineConsent />
          {judging && engineLoading && <BrowserAnalysisNotice />}
        </>
      )}

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

      {!reveal && !judging && (
        // 盤から離して控えめに置く（prd/13 §7.1）
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
}) {
  const verdict = resultBadge(drill.kind, reveal.verdict, reveal.practice);
  const note = practiceNote(reveal.practice, reveal.recorded);
  // 大きいボタンは「次の問題」＋今の入口のアイコン（読み上げは aria-label で入口名まで）
  const nextLabel = mode ? (
    <>
      次の問題
      <DrillModeIcon mode={mode} />
    </>
  ) : (
    '一覧に戻る'
  );
  const otherModes = (['recommend', 'mate', 'best', 'wrong'] as const).filter((other) => other !== mode);
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

      {/*
        解いた後のボタン（prd/13 §7.6）。入口の続き（大）と、ほかの入口へのドロップダウンを join で 1 本につなぐ。
        元の対局・やり直す・自明だったは上の行のケバブ（`SolveMenu`）
      */}
      <div className="join w-full">
        <button
          type="button"
          className="btn btn-primary join-item flex-1 px-2"
          onClick={onNext}
          aria-label={mode ? `次の問題（${MODE_LABEL[mode]}）` : undefined}
        >
          {nextLabel}
        </button>
        <div className="dropdown dropdown-end join-item">
          <div
            tabIndex={0}
            role="button"
            className="btn btn-primary join-item w-16 px-0 border-0 border-l border-l-primary-content/40"
            aria-label="ほかの入口"
          >
            <ChevronDownIcon className="size-5" />
          </div>
          <ul tabIndex={0} className="dropdown-content menu bg-base-100 rounded-box z-10 mt-1 w-44 p-2 shadow">
            {/* 今の入口と同じになるものは出さない */}
            {otherModes.map((other) => (
              <li key={other}>
                <Link to="/drills" search={modeSearch(other)} replace className="text-base">
                  <DrillModeIcon mode={other} />
                  {MODE_LABEL[other]}
                </Link>
              </li>
            ))}
          </ul>
        </div>
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

/**
 * 盤の上に重ねる成 / 不成の選択（`BoardGrid`）。`move` は指したばかりの手（不成の形）で、`state` はそれを指した後の局面。
 * 選ぶ前の盤は不成の形で駒が乗っているので、行き先の駒をそのまま「成らない形」として出す
 */
function promotionChoiceOf(
  state: BoardState,
  move: string,
  onChoose: (promote: boolean) => void,
  onCancel: () => void,
): PromotionChoice | null {
  const square = squareOfUsi(move.slice(2, 4));
  const piece = pieceAt(state, square);
  return piece ? { square, side: piece.side, piece: piece.kind, onChoose, onCancel } : null;
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


