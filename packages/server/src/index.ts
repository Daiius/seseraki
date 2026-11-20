import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { client } from './db/index.js';
import { endSystemDb, systemDb } from './db/system.js';
import { createGracefulShutdown } from './graceful-shutdown.js';
import { app } from './route.js';

// 🔒 RLS を迂回する system ロールの設定漏れは**起動の失敗**として出す（fail-closed。prd/15 §2）。
// 遅らせると、worker の報告の最初の 1 件で初めて落ちる
systemDb();

// 停止の合図で、処理中のリクエスト（ハンドラと応答の書き出し）を終えてから DB のプールを閉じて終了する
const shutdown = createGracefulShutdown({
  closers: [
    { name: 'db(server)', close: () => client.end() },
    { name: 'db(system)', close: endSystemDb },
  ],
});

// `createServer` を渡していないので node:http の Server（戻り値の型は http2 との合併なので絞る）
const server = serve(
  {
    fetch: shutdown.track(app.fetch),
    port: 4000,
  },
  (info) => {
    console.log(`Server is running on http://localhost:${info.port}`);
  },
) as Server;
shutdown.install(server);
