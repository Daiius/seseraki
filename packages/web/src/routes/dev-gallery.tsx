import { type ReactNode } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { AnalyzingRadial } from '../components/AnalyzingRadial';
import { AnalyzingAlert } from '../components/AnalyzingAlert';

/**
 * DEV 専用の UI ギャラリー。特定の表示状態（解析中など）を、認証も API も loader も通さず
 * props を手で与えて描画するための置き場。Playwright MCP でモバイル幅にリサイズして
 * スクリーンショットを撮り、レイアウトの折り返しや揃えを目視確認するのに使う。
 *
 * 本番では中身を出さない（`import.meta.env.DEV` ガード）。認証バイパスも `__root` 側で
 * DEV 限定にしてある。新しい表示を足したら、ここに 1 ケース追加すると撮って確認できる。
 */
export const Route = createFileRoute('/dev-gallery')({
  component: Gallery,
});

function Case({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold text-base-content/70">{title}</h2>
      <div className="rounded-box border border-base-300 p-4">{children}</div>
    </section>
  );
}

function Gallery() {
  if (!import.meta.env.DEV) return null;
  return (
    <div className="space-y-8">
      <p className="text-sm text-base-content/70">
        DEV 専用の UI ギャラリー。表示状態を props で固定して並べています（本番では表示されません）。
      </p>

      <Case title="一覧・状態セル（解析中の円環）">
        {/* 実際の状態セル（`index.tsx` の `flex gap-1 items-center`）の並びを再現し、
            他バッジと同居してもモバイル幅で折り返さないかを見る */}
        <div className="flex gap-1 items-center">
          <span className="badge badge-soft badge-success badge-sm">勝</span>
          <AnalyzingRadial analyzed={12} total={150} />
          <span className="badge badge-sm bg-info/50 text-info-content">●</span>
        </div>
      </Case>

      <Case title="一覧・円環の進行度（0% / 25% / 100%）">
        <div className="flex gap-4 items-center">
          <AnalyzingRadial analyzed={0} total={150} />
          <AnalyzingRadial analyzed={38} total={150} />
          <AnalyzingRadial analyzed={150} total={150} />
        </div>
      </Case>

      <Case title="詳細・解析中 alert（文言と progress の縦中央揃え）">
        <AnalyzingAlert analyzed={12} total={150} agoText="3秒前に更新" />
      </Case>
    </div>
  );
}
