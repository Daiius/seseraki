import { useState } from 'react';
import {
  createFileRoute,
  Link,
  useNavigate,
  useRouter,
} from '@tanstack/react-router';
import clsx from 'clsx';
import { client } from '../../lib/honoClient';
import { buildPositions } from 'shared';
import { formatUpdatedAgo } from '../../lib/analysisProgress';
import { useAnalysisProgress } from '../../lib/useAnalysisProgress';
import { useThresholds } from '../../lib/thresholds';
import { usePlyUrlSync } from '../../lib/usePlyUrlSync';
import { ShogiBoard } from '../../components/ShogiBoard';
import { AnalyzingAlert } from '../../components/AnalyzingAlert';
import { CopyButton } from '../../components/CopyButton';
import { KifuExport } from '../../components/KifuExport';
import { KifuMemo } from '../../components/KifuMemo';
import { LazyDetails } from '../../components/LazyDetails';
import { TacticTags } from '../../components/TacticTags';
import { ICON_BTN, MENU_ITEM, MENU_LIST } from '../../lib/touchTargets';

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

/** `ply` は 0（初期局面）以上の整数だけ受ける。それ以外は指定なしと同じ扱い */
function plyParam(raw: unknown): number | undefined {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

export const Route = createFileRoute('/kifus/$id')({
  validateSearch: (search: Record<string, unknown>): KifuDetailSearch => ({
    ply: plyParam(search.ply),
  }),
  loader: async ({ params }) => {
    const res = await client.api.kifus[':id'].$get({
      param: { id: params.id },
    });
    if (!res.ok) throw new Error('Kifu not found');
    return await res.json();
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

  // 🔴 **この画面が解析の完了を待っているか**をローダーのデータから導く（決定・2026-09-07）。
  // 詳細解析まで終わっていない棋譜（`analysisProfile !== 'full'`）なら待っている。
  // 失敗記録済みの棋譜は poll から外れて進まないので待たない（prd/05 §1.1a）。
  // 待っている間は短間隔ポーリング + 定期 invalidate が回り、簡易解析が 20 秒で終わっても
  // 手で再読み込みせずに結果へ切り替わる（ポーリングの合間に解析全体が収まっても取りこぼさない）
  const pendingAnalysis =
    kifu.analysisProfile !== 'full' && !kifu.analysisError;
  // 解析中は高々 1 件なので、返ってきた進捗がこの棋譜のものかを id で照合する
  const { progress, now, estimated } = useAnalysisProgress({
    pending: pendingAnalysis,
  });
  const analyzing = progress && progress.kifuId === kifu.id ? progress : null;

  // 悪手判定の閾値は localStorage 保持。盤面・グラフ・LLM 解説用テキストで同じ値を使う。
  // 変更 UI は全棋譜に効く設定なので `/settings` にある（§2.5）
  const { thresholds } = useThresholds();

  const usiMoves: string[] = kifu.usiMoves ?? [];

  // USI 指し手列から盤面を構築。全局面はここで 1 度だけ作り、盤面へ渡す
  const positions = buildPositions(usiMoves);

  /**
   * kebab メニューを閉じる。
   *
   * daisyUI の dropdown は JS を持たず `:focus` / `:focus-within` で開閉するため、
   * 中の項目を押してもフォーカスが内側に残ったままで開きっぱなしになる。
   * 押した要素のフォーカスを明示的に外して閉じる。
   */
  const closeMenu = () => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  };

  const handleDelete = async () => {
    if (!confirm('この棋譜を削除しますか？')) return;
    setActionResult(null);
    setBusy(true);
    try {
      const res = await client.api.kifus[':id'].$delete({
        param: { id: String(kifu.id) },
      });
      if (!res.ok) {
        setActionResult({ kind: 'error', message: `削除に失敗しました (${res.status})` });
        return;
      }
      navigate({ to: '/' });
    } catch {
      setActionResult({ kind: 'error', message: 'サーバーに接続できません' });
    } finally {
      setBusy(false);
    }
  };

  // kifText を再変換して解析状態をリセットし、worker に拾い直させる。
  // パーサ修正後の既存棋譜の復旧・失敗棋譜の再試行を兼ねる。
  const handleReanalyze = async () => {
    setActionResult(null);
    setBusy(true);
    try {
      const res = await client.api.kifus[':id'].reanalyze.$post({
        param: { id: String(kifu.id) },
      });
      if (!res.ok) {
        setActionResult({ kind: 'error', message: `再解析に失敗しました (${res.status})` });
        return;
      }
      setActionResult({
        kind: 'info',
        message: '再解析を開始しました。完了までしばらくかかります',
      });
      router.invalidate();
    } catch {
      setActionResult({ kind: 'error', message: 'サーバーに接続できません' });
    } finally {
      setBusy(false);
    }
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
          <h2 className="text-2xl font-bold">{kifu.title}</h2>
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
          <ul tabIndex={0} className={clsx(MENU_LIST, 'w-32')}>
            {/* メニュー項目は押しても dropdown が閉じないので、実行前に明示的に閉じる */}
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

      <div className="flex flex-col gap-6">
        {actionResult && (
          <div
            role="alert"
            className={clsx(
              'alert',
              actionResult.kind === 'error' ? 'alert-error' : 'alert-info',
            )}
          >
            <span>{actionResult.message}</span>
          </div>
        )}

        {analyzing && (
          <AnalyzingAlert
            profile={analyzing.profile}
            analyzed={analyzing.analyzed}
            estimated={estimated}
            total={analyzing.total}
            agoText={formatUpdatedAgo(analyzing, now)}
          />
        )}

        {kifu.analysisError && (
          <div className="alert alert-error flex items-start gap-3">
            <div className="flex-1">
              {/* ⚠ `analysisCompletedAt` と `analysisError` の排他は意図して緩めてある
                  （prd/05 §1.1d）。quick 完了後に詳細解析が失敗した棋譜は、**quick の結果を
                  見せたまま**この失敗表示が出る。文言は段階で変えない（決定・2026-09-05 後段） */}
              <div className="font-semibold">解析失敗</div>
              <div className="text-sm font-mono break-all opacity-90">
                {kifu.analysisError}
              </div>
            </div>
            <button
              className="btn btn-sm"
              onClick={handleReanalyze}
              disabled={busy}
            >
              再解析
            </button>
          </div>
        )}

        {usiMoves.length > 0 && (
          <ShogiBoard
            /*
              🔴 **key に `ply` を入れない。** `ply` は手送りのたびに変わるので、
              入れると**毎手盤が作り直され、反転・分岐の再生位置・検討中の手順が消える**。
              URL → 盤の向きは初期表示の 1 回だけで、以後は盤が真実の側
              （`onMoveIndexChange` で URL を追随させる。prd/05 §2.6）。
              棋譜を跨ぐ移動で手数が持ち越されないよう、id だけを key にする
            */
            key={kifu.id}
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
          <KifuMemo kifuId={kifu.id} memo={kifu.memo} />
        </LazyDetails>
      </div>
    </div>
  );
}
