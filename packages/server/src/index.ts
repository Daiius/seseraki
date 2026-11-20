import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { client } from './db/index.js';
import { endSystemDb, systemDb } from './db/system.js';
import { installGracefulShutdown } from './graceful-shutdown.js';
import { app } from './route.js';

// 🔒 RLS を迂回する system ロールの設定漏れは**起動の失敗**として出す（fail-closed。prd/15 §2）。
// 遅らせると、worker の報告の最初の 1 件で初めて落ちる
systemDb();

// `createServer` を渡していないので node:http の Server（戻り値の型は http2 との合併なので絞る）
const server = serve(
  {
    fetch: app.fetch,
    port: 4000,
  },
  (info) => {
    console.log(`Server is running on http://localhost:${info.port}`);
  },
) as Server;

// 停止の合図で、処理中のリクエストを終えてから DB のプールを閉じて終了する
installGracefulShutdown({
  server,
  closers: [
    { name: 'db(server)', close: () => client.end() },
    { name: 'db(system)', close: endSystemDb },
  ],
});
