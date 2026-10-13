import { rootRouteId, useRouteContext } from '@tanstack/react-router';
import type { AnalysisAssignee, Me } from './auth';

/**
 * ログイン中の自分（`__root.tsx` の `beforeLoad` が `GET /api/me` から取った値）。
 * ログイン画面など、ログインを通さないページでは null。
 */
export function useMe(): Me | null {
  return useRouteContext({
    from: rootRouteId,
    select: (context) => context.account,
  });
}

/**
 * 解析する側（prd/14 §5.7）。分からないとき（ログインを通さないページ）は `worker` として扱う
 * ——ブラウザ解析は動かさず、表示は従来どおりにする。
 */
export function useAnalysisAssignee(): AnalysisAssignee {
  return useMe()?.analysisAssignee ?? 'worker';
}
