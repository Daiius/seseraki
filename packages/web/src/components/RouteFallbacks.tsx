import { Link, type ErrorComponentProps } from '@tanstack/react-router';

/*
  ルートの読み込みに失敗したとき・ページが無いときの表示（`main.tsx` の `createRouter` の既定）。
  ルートのレイアウト（ヘッダー）の中に出るので、ここは本文だけを持つ。
*/

/** loader が投げた失敗（通信断・5xx など）。404 は `notFound()` で {@link RouteNotFound} へ回る */
export function RouteError({ error }: ErrorComponentProps) {
  return (
    <div className="flex flex-col items-start gap-3">
      <h2 className="text-xl font-bold">読み込めませんでした</h2>
      {error instanceof Error && error.message && (
        <p className="text-sm text-base-content/70 [overflow-wrap:anywhere]">{error.message}</p>
      )}
      <Link to="/" className="btn btn-sm">
        一覧へ戻る
      </Link>
    </div>
  );
}

/** ページ・棋譜が見つからない */
export function RouteNotFound() {
  return (
    <div className="flex flex-col items-start gap-3">
      <h2 className="text-xl font-bold">見つかりませんでした</h2>
      <Link to="/" className="btn btn-sm">
        一覧へ戻る
      </Link>
    </div>
  );
}
