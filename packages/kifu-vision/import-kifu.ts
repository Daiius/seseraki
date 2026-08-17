// 走査結果（JSON）を seseraki の取り込み API へ送る（prd/10 §4.1）。
//
//   pnpm --filter kifu-vision exec tsx import-kifu.ts <棋譜 json> ...
//
// 🔒 **取り込みの意味論は server 側にある**（KIF の合成・往復検証・差分ログ・
// 戦型の同期・解析のリセット）。ここは走査結果を API の形に詰め替えて送るだけで、
// **判断を持たない**。DB へ直接繋がないのも同じ理由（prd/10 §4.1 の ⏹）。
//
// 環境変数:
//   KIFU_VISION_IMPORT_URL   送信先（既定は web の開発プロキシ経由）
//   API_KEY                  未設定ならリポジトリの .env.server から読む
//   KIFU_VISION_IMPORT_DRY_RUN=1  送らずに送信内容の要約だけ出す
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error('使い方: tsx import-kifu.ts <棋譜 json> ...');
  process.exit(1);
}

const url =
  process.env.KIFU_VISION_IMPORT_URL ??
  'http://localhost:5173/api/video-analysis/kifus';
const dryRun = process.env.KIFU_VISION_IMPORT_DRY_RUN === '1';

/** API_KEY を環境変数か `.env.server` から取る（worker と同じ鍵） */
function apiKey(): string {
  if (process.env.API_KEY) return process.env.API_KEY;
  const env = readFileSync(join(REPO_ROOT, '.env.server'), 'utf8');
  const line = env.match(/^API_KEY=(.*)$/m);
  if (!line) throw new Error('API_KEY が環境変数にも .env.server にも無い');
  return line[1].trim().replace(/^["']|["']$/g, '');
}

/**
 * 走査時のコードを特定するための印。
 * ⚠ **未コミットの変更があれば `-dirty` を付ける。** その走査は後から再現できないので、
 * コミットハッシュだけを記録すると「このハッシュで走らせた結果」という嘘になる。
 */
function extractorRev(): string {
  const rev = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim();
  return dirty ? `${rev}-dirty` : rev;
}

interface Run {
  startedAt: number;
  endedAt: number;
  moveCount: number;
  usi: string[];
  replay?: { legal: number; total: number; problems: unknown[] };
}

const rev = extractorRev();
const key = dryRun ? '' : apiKey();
let sent = 0;
let failed = 0;

for (const path of paths) {
  const data = JSON.parse(readFileSync(path, 'utf8'));
  const videoId = String(data.source).replace(/\.[^.]+$/, '');

  // 🔒 **初期局面から繋がるのは最初の断片だけ**（check-kifu.ts と同じ扱い）。
  // 途中から始まる断片は起点が分からないので棋譜にならない
  const runs = [...(data.runs as Run[])].sort((a, b) => a.startedAt - b.startedAt);
  const run = runs[0];
  if (!run) {
    console.error(`⚠ ${path}: 断片が 1 つも無い`);
    failed++;
    continue;
  }
  if (runs.length > 1) {
    const dropped = runs.slice(1).reduce((n, r) => n + r.moveCount, 0);
    console.warn(
      `⚠ ${videoId}#${data.game}: 断片が ${runs.length} 本ある。最初の 1 本だけを送る` +
        `（残り ${dropped} 手は棋譜に入らない）`,
    );
  }
  // 合法性は server 側で検査していない（往復検証は KIF の話）。**ここで気づけるようにする**
  if (run.replay && run.replay.problems.length > 0) {
    console.warn(
      `⚠ ${videoId}#${data.game}: 通し再生に ${run.replay.problems.length} 件の指摘がある` +
        `（合法 ${run.replay.legal} / ${run.replay.total}）`,
    );
  }

  const payload = {
    videoId,
    gameIndex: data.game as number,
    startedAtSec: Math.floor(run.startedAt),
    endedAtSec: Math.floor(run.endedAt),
    bottomIsSente: data.bottomIsSente as boolean,
    extractorRev: rev,
    usi: run.usi,
    raw: data,
  };

  const tag = `${videoId}#${payload.gameIndex}`;
  if (dryRun) {
    console.log(
      `[dry-run] ${tag} ${payload.usi.length} 手 ` +
        `${payload.startedAtSec}〜${payload.endedAtSec}s rev=${rev}`,
    );
    continue;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    console.error(`🔴 ${tag}: ${res.status} ${JSON.stringify(body)}`);
    failed++;
    continue;
  }
  sent++;
  const { kifuId, created, changed, diff } = body as {
    kifuId: number;
    created: boolean;
    changed: boolean;
    diff: { moveNumber: number; before: string | null; after: string | null }[];
  };
  if (created) {
    console.log(`✅ ${tag} 新規 kifu=${kifuId} ${payload.usi.length} 手`);
  } else if (changed) {
    // 🔒 上書きで何が変わったかは、手数や指標では見えない（prd/10 §4.3）
    const head = diff
      .slice(0, 5)
      .map((d) => `${d.moveNumber}: ${d.before ?? '(なし)'} → ${d.after ?? '(なし)'}`)
      .join(' / ');
    const rest = diff.length > 5 ? ` ほか ${diff.length - 5} 件` : '';
    console.log(`♻ ${tag} 上書き kifu=${kifuId} 差分 ${diff.length} 件: ${head}${rest}`);
  } else {
    console.log(`= ${tag} 変化なし kifu=${kifuId}`);
  }
}

console.log(`\n${sent} 件送信 / ${failed} 件失敗`);
if (failed > 0) process.exit(1);
