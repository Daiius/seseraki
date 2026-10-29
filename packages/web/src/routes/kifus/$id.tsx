import { useEffect, useState } from 'react';
import {
  createFileRoute,
  Link,
  notFound,
  useNavigate,
  useRouter,
} from '@tanstack/react-router';
import clsx from 'clsx';
import { client } from '../../lib/honoClient';
import { callApi } from '../../lib/callApi';
import { intParam } from '../../lib/searchParams';
import { buildPositions } from 'shared';
import { useAnalysisProgress } from '../../lib/useAnalysisProgress';
import { isAnalysisPending } from '../../lib/analysisPending';
import { useAnalysisAssignee } from '../../lib/useMe';
import {
  BrowserAnalysisNotice,
  useBrowserAnalysisFocus,
} from '../../components/BrowserAnalysis';
import { useThresholds } from '../../lib/thresholds';
import { usePlyUrlSync } from '../../lib/usePlyUrlSync';
import { ShogiBoard } from '../../components/ShogiBoard';
import {
  ActionResultToast,
  AnalysisErrorToast,
  AnalyzingToast,
  ToastStack,
} from '../../components/KifuToasts';
import { CopyButton } from '../../components/CopyButton';
import { KifuExport } from '../../components/KifuExport';
import { KifuMemo } from '../../components/KifuMemo';
import { LazyDetails } from '../../components/LazyDetails';
import { TacticTags } from '../../components/TacticTags';
import { ICON_BTN, MENU_ITEM, MENU_LIST } from '../../lib/touchTargets';
import { closeMenu } from '../../lib/closeMenu';
import { EllipsisVerticalIcon } from '../../components/icons';

/** 成功・情報の通知を自動で消すまでの時間（読み切れる長さ。エラーは自動で消さない） */
const INFO_TOAST_MS = 5_000;

/** 棋譜詳細の URL 検索条件 */
export interface KifuDetailSearch {
  /**
   * 表示を開始する手数（初期局面からの手数 = 盤面の `moveIndex`）。
   *
   * 出題の解答表示・出題の一覧・局面検索から「その手」へ直接飛ぶための入口
   * （prd/13 §7.1・prd/10 §3.2）であり、**閲覧中の手送りにも追随する**
   * （prd/05 §2.6）。追随は `replace` + throttle で書く——理由は `usePlyUrlSync`。
   * 範囲外の値は盤側で端に丸める。
   */
  ply?: number;
}

/**
 * 棋譜詳細。🔒 **パスの `$id` は棋譜の番号**（所有者ごとの連番 `no`。prd/14 §4.4）で、内部の主キーではない。
 * 同じ URL でもログインしている人ごとに別の棋譜を指す
 */
export const Route = createFileRoute('/kifus/$id')({
  // `ply` は 0（初期局面）以上の整数だけ受ける。それ以外は指定なしと同じ扱い
  validateSearch: (search: Record<string, unknown>): KifuDetailSearch => ({
    ply: intParam(search.ply, 0),
  }),
  // 無い棋譜（他人の棋譜も同じ 404）は「見つかりません」、それ以外の失敗は状態コードを含めて
  // 「読み込めませんでした」（どちらもルートの既定の表示。`components/RouteFallbacks.tsx`）
  loader: async ({ params }) => {
    const result = await callApi(client.api.kifus[':no'].$get({ param: { no: params.id } }));
    if (result.ok) return result.data;
    if (result.status === 404) throw notFound();
    throw new Error(`棋譜を読み込めませんでした: ${result.error}`);
  },
  component: KifuDetailPage,
});

function KifuDetailPage() {
  const kifu = Route.useLoaderData();
  const { ply } = Route.useSearch();
  const syncPly = usePlyUrlSync();
  const navigate = useNavigate();
  const router = useRouter();

  // 削除・再解析の結果表示。失敗を握り潰すとボタンを押しても何も起きないように見えるため、
  // 成否をここに出す（成功時の再解析も画面変化が乏しいので通知する）
  const [actionResult, setActionResult] = useState<{
    kind: 'error' | 'info';
    message: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  // 成功・情報の通知は数秒で消す。エラーは見落とすと「押しても何も起きない」に見えるので、
  // × で閉じるまで残す
  useEffect(() => {
    if (!actionResult || actionResult.kind === 'error') return;
    const timer = setTimeout(() => setActionResult(null), INFO_TOAST_MS);
    return () => clearTimeout(timer);
  }, [actionResult]);

  // 解析失敗の通知を × で閉じた記録。**棋譜と失敗内容の組**で持ち、別の棋譜へ移ったときや
  // 失敗内容が変わったときは再表示する（再解析を押したときも記録を捨てる——同じ文言で
  // 失敗し直しても出す）
  const [dismissedError, setDismissedError] = useState<{
    kifuNo: number;
    error: string;
  } | null>(null);
  const analysisError =
    kifu.analysisError &&
    !(
      dismissedError?.kifuNo === kifu.no &&
      dismissedError.error === kifu.analysisError
    )
      ? kifu.analysisError
      : null;

  // 🔴 **この画面が解析の完了を待っているか**をローダーのデータから導く（決定・2026-09-07）。
  // 完了は解析する側によらず詳細解析（full）まで（`isAnalysisPending`。prd/14 §5.7）。
  // 失敗記録済みの棋譜は poll から外れて進まないので待たない（prd/05 §1.1a）。
  // 待っている間は短間隔ポーリング + 定期 invalidate が回り、簡易解析が 20 秒で終わっても
  // 手で再読み込みせずに結果へ切り替わる（ポーリングの合間に解析全体が収まっても取りこぼさない）
  const assignee = useAnalysisAssignee();
  const pendingAnalysis = isAnalysisPending({
    analysisProfile: kifu.analysisProfile,
    failed: !!kifu.analysisError,
  });
  // ブラウザで解析するユーザーでは、開いている間この棋譜を（最優先で）解析させる（prd/14 §5.10）。
  // 🔒 full まで待つので、quick が終わっても外さない（quick → full を続けて回す）。
  // 指し手列の無い棋譜は解析の対象にならないので知らせない
  const browserPending =
    assignee === 'browser' && pendingAnalysis && kifu.usiMoves !== null;
  useBrowserAnalysisFocus(browserPending ? kifu.no : null);
  // 解析中は高々 1 件なので、返ってきた進捗がこの棋譜のものかを番号で照合する。
  // ブラウザで解析するユーザーでは、server に聞かずこのタブの解析の進捗が返る
  const { progress, estimated } = useAnalysisProgress({
    pending: pendingAnalysis,
    assignee,
  });
  const analyzing = progress && progress.kifuNo === kifu.no ? progress : null;

  // 悪手判定の閾値は localStorage 保持。盤面・グラフ・LLM 解説用テキストで同じ値を使う。
  // 変更 UI は全棋譜に効く設定なので `/settings` にある（§2.5）
  const { thresholds } = useThresholds();

  const usiMoves: string[] = kifu.usiMoves ?? [];

  // USI 指し手列から盤面を構築。全局面はここで 1 度だけ作り、盤面へ渡す
  const positions = buildPositions(usiMoves);

  const handleDelete = async () => {
    if (!confirm('この棋譜を削除しますか？')) return;
    setActionResult(null);
    setBusy(true);
    const result = await callApi(
      client.api.kifus[':no'].$delete({ param: { no: String(kifu.no) } }),
      { fallback: (status) => `削除に失敗しました (${status})` },
    );
    setBusy(false);
    if (!result.ok) {
      setActionResult({ kind: 'error', message: result.error });
      return;
    }
    navigate({ to: '/' });
  };

  // kifText を再変換して解析状態をリセットし、worker に拾い直させる。
  // パーサ修正後の既存棋譜の復旧・失敗棋譜の再試行を兼ねる。
  const handleReanalyze = async () => {
    setActionResult(null);
    setDismissedError(null);
    setBusy(true);
    const result = await callApi(
      client.api.kifus[':no'].reanalyze.$post({ param: { no: String(kifu.no) } }),
      { fallback: (status) => `再解析に失敗しました (${status})` },
    );
    setBusy(false);
    if (!result.ok) {
      setActionResult({ kind: 'error', message: result.error });
      return;
    }
    setActionResult({
      kind: 'info',
      message: '再解析を開始しました。完了までしばらくかかります',
    });
    router.invalidate();
  };

  // 主体側は server が導出済み（prd/11 §4）
  const userSide = kifu.subjectSide ?? null;

  return (
    <div>
      <div className="flex items-center gap-4 mb-4">
        <Link to="/" className="btn btn-ghost btn-sm">
          ← 一覧
        </Link>
        {/* 戦型はタイトルの直下に置く。対局の性格を一目で掴む情報なので、
            盤面やメニューより先に目に入る位置がよい */}
        <div className="min-w-0">
          {/* 🔴 **段階のバッジは置かない**（決定・2026-09-05 後段）。簡易解析だけが
              終わっている状態は直後に詳細解析が走る一時的な状態で、モバイルの横幅を
              恒久的に食う表示に見合わない。段階は解析中の進捗バーの濃さで分かる */}
          <h2 className="text-2xl font-bold">
            {/* 棋譜の番号（所有者ごと。prd/14 §4.4）。一覧と同じく控えめに添える */}
            <span className="mr-2 text-base font-normal tabular-nums text-base-content/50">
              #{kifu.no}
            </span>
            {kifu.title}
          </h2>
          <TacticTags tactics={kifu.tactics} userSide={userSide} className="mt-1" />
        </div>
        <div className="dropdown dropdown-end ml-auto">
          {/*
            🔒 **⋯ メニューは表示サイズの設定（`controlSize`）に連動させない**
            （prd/05 §2.1・決定 2026-09-01）。操作ボタンをモバイルでも 32px まで
            縮められるようにした例外は、**取り返しのつかない操作（削除・再解析）が
            縮まない側に隔離されている**ことを安全策として成り立っている。
            ここを一緒に縮めると的が小さくなるだけでなく、その論の足が外れる。
            トリガーも項目も**設定に関わらず常に 44px**（`lib/touchTargets.ts`）。
          */}
          <button
            tabIndex={0}
            className={ICON_BTN}
            aria-label="メニュー"
          >
            <EllipsisVerticalIcon />
          </button>
          <ul tabIndex={0} className={clsx(MENU_LIST, 'w-32')}>
            {/* メニュー項目は押しても dropdown が閉じないので、実行前に明示的に閉じる（`lib/closeMenu.ts`） */}
            <li>
              <button
                onClick={() => {
                  closeMenu();
                  void handleReanalyze();
                }}
                className={MENU_ITEM}
                disabled={busy}
              >
                再解析
              </button>
            </li>
            <li>
              <button
                onClick={() => {
                  closeMenu();
                  void handleDelete();
                }}
                className={clsx(MENU_ITEM, 'text-error')}
                disabled={busy}
              >
                削除
              </button>
            </li>
          </ul>
        </div>
      </div>

      {/* 通知は本文の列の右上（このヘッダーの直下）に浮かせる。本文に場所を取らせない。
          位置はここに置くことで決まるので、ヘッダーの直後から動かさない（`ToastStack`） */}
      <ToastStack>
        {actionResult && (
          <ActionResultToast
            kind={actionResult.kind}
            message={actionResult.message}
            onClose={() => setActionResult(null)}
          />
        )}
        {/* ブラウザ解析の案内（初回のダウンロードの同意・準備中・解析できない理由）。
            解析が動いている間は何も出ない */}
        {browserPending && <BrowserAnalysisNotice />}
        {analyzing && (
          <AnalyzingToast
            profile={analyzing.profile}
            analyzed={analyzing.analyzed}
            estimated={estimated}
            total={analyzing.total}
          />
        )}
        {/* ⚠ `analysisCompletedAt` と `analysisError` の排他は意図して緩めてある
            （prd/05 §1.1d）。quick 完了後に詳細解析が失敗した棋譜は、**quick の結果を
            見せたまま**この失敗表示が出る。文言は段階で変えない（決定・2026-09-05 後段） */}
        {analysisError && (
          <AnalysisErrorToast
            error={analysisError}
            onReanalyze={() => void handleReanalyze()}
            onClose={() =>
              setDismissedError({ kifuNo: kifu.no, error: analysisError })
            }
            busy={busy}
          />
        )}
      </ToastStack>

      <div className="flex flex-col gap-6">
        {usiMoves.length > 0 && (
          <ShogiBoard
            /*
              🔴 **key に `ply` を入れない。** `ply` は手送りのたびに変わるので、
              入れると**毎手盤が作り直され、反転・分岐の再生位置・検討中の手順が消える**。
              URL → 盤の向きは初期表示の 1 回だけで、以後は盤が真実の側
              （`onMoveIndexChange` で URL を追随させる。prd/05 §2.6）。
              棋譜を跨ぐ移動で手数が持ち越されないよう、棋譜の番号だけを key にする
            */
            key={kifu.no}
            initialMoveIndex={ply ?? 0}
            onMoveIndexChange={syncPly}
            usiMoves={usiMoves}
            positions={positions}
            analyses={kifu.analyses}
            sente={kifu.sente}
            gote={kifu.gote}
            subjectSide={userSide}
            thresholds={thresholds}
          />
        )}

        <LazyDetails title="KIF">
          <div className="flex flex-col gap-2">
            <CopyButton
              text={kifu.kifText}
              label="KIF をコピー"
              className="btn-outline self-end"
            />
            <pre className="text-sm font-mono whitespace-pre-wrap">
              {kifu.kifText}
            </pre>
          </div>
        </LazyDetails>

        {kifu.analyses.length > 0 && (
          <LazyDetails title="LLM 解説用テキスト">
            <KifuExport
              userSide={userSide}
              kifu={{
                title: kifu.title,
                usiMoves,
                sente: kifu.sente,
                gote: kifu.gote,
                senteDan: kifu.senteDan,
                goteDan: kifu.goteDan,
                result: kifu.result,
                playedAt: kifu.playedAt,
                thresholds,
                analyses: kifu.analyses,
              }}
            />
          </LazyDetails>
        )}

        <LazyDetails title="メモ">
          <KifuMemo kifuNo={kifu.no} memo={kifu.memo} />
        </LazyDetails>
      </div>
    </div>
  );
}
