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
//   KIFU_VISION_VIDEO_ID     動画の識別子（走査 json に `videoId` が無いときは必須）
//   KIFU_VISION_IMPORT_FORCE=1    通し再生に指摘のある棋譜も送る（既定は中止）
//
// 🔒 **`(videoId, gameIndex)` は server 側の上書きキー**（prd/10 §4.3）。走査 json の
// `source` は動画の basename しか持たないので、**別の録画が同じ名前なら既存の棋譜を
// 静かに置き換えてしまう**。識別子は推測せず、明示されたものだけを使う。
//
// 🔒 **通し再生の指摘は警告で済ませない。** server は合法性を検査しない（往復検証は
// KIF の話）ので、ここで止めなければ手番の欠落や持っていない駒の打ちがそのまま
// 正式な `kifus.usiMoves` と局面索引に入る。調査目的で送りたいときだけ FORCE を立てる。
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
/** 🔒 通し再生に指摘のある棋譜を、承知のうえで送るための逃げ道（既定は中止） */
const force = process.env.KIFU_VISION_IMPORT_FORCE === '1';

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
  // 🔒 basename から推測しない（同名の別録画が既存の棋譜を上書きする）。
  const videoId: string | undefined = data.videoId ?? process.env.KIFU_VISION_VIDEO_ID;
  if (!videoId) {
    console.error(
      `🔴 ${path}: 動画の識別子が無い。走査 json の videoId か KIFU_VISION_VIDEO_ID で渡すこと` +
        `（source="${data.source}" は basename なので上書きキーには使わない）`,
    );
    failed++;
    continue;
  }

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
  // 🔒 合法性は server 側で検査していない（往復検証は KIF の話）。**ここで止める。**
  const replay = run.replay;
  const unsound = !replay || replay.problems.length > 0 || replay.legal !== replay.total;
  if (unsound) {
    const detail = replay
      ? `通し再生に ${replay.problems.length} 件の指摘がある（合法 ${replay.legal} / ${replay.total}）`
      : '通し再生の結果が走査 json に入っていない';
    if (!force) {
      console.error(
        `🔴 ${videoId}#${data.game}: ${detail}。送らない` +
          `（承知のうえで送るなら KIFU_VISION_IMPORT_FORCE=1）`,
      );
      failed++;
      continue;
    }
    console.warn(`⚠ ${videoId}#${data.game}: ${detail}。FORCE が立っているので送る`);
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
