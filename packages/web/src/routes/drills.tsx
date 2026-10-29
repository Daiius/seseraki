import { createFileRoute, redirect } from '@tanstack/react-router';
import {
  loadCounts,
  loadList,
  loadNext,
  loadOne,
  refOf,
} from '../lib/drillApi';
import { DrillHome } from '../components/DrillHome';
import { DrillListScreen } from '../components/DrillListScreen';
import { DrillRunner } from '../components/DrillRunner';
import { Exhausted, RoundBar } from '../components/DrillRoundBar';
import { DrillGradingHost } from '../components/BrowserAnalysis';
import { useAnalysisAssignee } from '../lib/useMe';
import {
  drillRefOf,
  drillScreenOf,
  pinnedSearch,
  validateDrillsSearch,
  type DrillsSearch,
} from '../lib/drillSearch';
import { drillRound } from '../lib/drillRound';

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
 *
 * ここに置くのは画面の振り分け（loader）だけ。通信は `lib/drillApi.ts`、画面は `components/` の
 * `DrillHome`（ホーム）・`DrillListScreen`（一覧）・`DrillRunner`（解く画面）・`DrillResult`（解答後）・
 * `DrillRoundBar`（上部の行とケバブ）。
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
