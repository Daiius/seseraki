import { useState } from 'react';
import {
  createFileRoute,
  Link,
  useNavigate,
  useRouter,
} from '@tanstack/react-router';
import clsx from 'clsx';
import { client } from '../../lib/honoClient';
import { buildPositions } from '../../lib/board';
import { ShogiBoard } from '../../components/ShogiBoard';
import { KifuExport } from '../../components/KifuExport';
import { KifuMemo } from '../../components/KifuMemo';
import { LazyDetails } from '../../components/LazyDetails';

export const Route = createFileRoute('/kifus/$id')({
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
  const navigate = useNavigate();
  const router = useRouter();

  // 削除・再解析の結果表示。失敗を握り潰すとボタンを押しても何も起きないように見えるため、
  // 成否をここに出す（成功時の再解析も画面変化が乏しいので通知する）
  const [actionResult, setActionResult] = useState<{
    kind: 'error' | 'info';
    message: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  const usiMoves: string[] = kifu.usiMoves ?? [];

  // USI 指し手列から盤面を構築。全局面はここで 1 度だけ作り、盤面へ渡す
  const positions = buildPositions(usiMoves);

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

  return (
    <div>
      <div className="flex items-center gap-4 mb-4">
        <Link to="/" className="btn btn-ghost btn-sm">
          ← 一覧
        </Link>
        <h2 className="text-2xl font-bold">{kifu.title}</h2>
        <div className="dropdown dropdown-end ml-auto">
          <button
            tabIndex={0}
            className="btn btn-ghost btn-sm"
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
          <ul
            tabIndex={0}
            className="dropdown-content menu menu-sm bg-base-100 rounded-box z-20 mt-1 w-32 p-1 shadow"
          >
            <li>
              <button onClick={handleReanalyze} disabled={busy}>
                再解析
              </button>
            </li>
            <li>
              <button
                onClick={handleDelete}
                className="text-error"
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

        {kifu.analysisError && (
          <div className="alert alert-error flex items-start gap-3">
            <div className="flex-1">
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
            usiMoves={usiMoves}
            positions={positions}
            analyses={kifu.analyses}
            sente={kifu.sente}
            gote={kifu.gote}
          />
        )}

        <LazyDetails title="KIF">
          <pre className="text-sm font-mono whitespace-pre-wrap">
            {kifu.kifText}
          </pre>
        </LazyDetails>

        {kifu.analyses.length > 0 && (
          <LazyDetails title="LLM 解説用テキスト">
            <KifuExport
              kifu={{
                title: kifu.title,
                usiMoves,
                sente: kifu.sente,
                gote: kifu.gote,
                senteDan: kifu.senteDan,
                goteDan: kifu.goteDan,
                result: kifu.result,
                playedAt: kifu.playedAt,
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
