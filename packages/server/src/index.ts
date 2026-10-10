import { serve } from '@hono/node-server';
import { systemDb } from './db/system.js';
import { app } from './route.js';

// 🔒 RLS を迂回する system ロールの設定漏れは**起動の失敗**として出す（fail-closed。prd/15 §2）。
// 遅らせると、worker の報告の最初の 1 件で初めて落ちる
systemDb();

serve(
  {
    fetch: app.fetch,
    port: 4000,
  },
  (info) => {
    console.log(`Server is running on http://localhost:${info.port}`);
  },
);
