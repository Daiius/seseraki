// 成果物（dist/engine）を node で実際に動かす統合テスト。
// manifest のとおりにグルーを読み込み、評価関数を渡して、USI の応答を確かめる。
//
// 成果物はコミットしないので、ビルドしていない環境（CI・ほかの人の手元）では skip する。
// 流すには先に `pnpm engine:build`（リポジトリのルートで）。
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { engineAssetPaths, parseEngineManifest } from 'shared';

const distDir = fileURLToPath(new URL('../dist/engine/', import.meta.url));
const manifestPath = join(distDir, 'manifest.json');
const runnerPath = fileURLToPath(new URL('./usi-runner.cjs', import.meta.url));

const hasArtifacts = existsSync(manifestPath);
if (!hasArtifacts) {
  console.warn(
    `[engine-wasm] 統合テストを skip します: ${manifestPath} がありません` +
      '（成果物はコミットしていません。リポジトリのルートで pnpm engine:build を流すと作れます）。',
  );
}

const sha256 = (path: string) =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

interface Step {
  send: string[];
  until: string;
  timeoutMs: number;
}

interface Session {
  /** エンジンが出した行（順番どおり）。 */
  lines: string[];
  /** 筋書きの各段で出た行。 */
  byStep: string[][];
}

/** 子プロセスでエンジンを動かし、出力を段ごとに分けて返す。 */
function runSession(
  files: { js: string; nnFile: string; progressFile: string },
  steps: Step[],
  timeoutMs: number,
): Promise<Session> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [runnerPath, JSON.stringify({ ...files, steps })],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout
      .setEncoding('utf8')
      .on('data', (chunk: string) => (stdout += chunk));
    child.stderr
      .setEncoding('utf8')
      .on('data', (chunk: string) => (stderr += chunk));

    // 子はコマンドの実行中にスレッドを塞ぐので、時間切れは親の側で見る。
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new Error(
          `エンジンが ${timeoutMs}ms で終わりませんでした。\n${stdout.slice(-2000)}\n${stderr.slice(-2000)}`,
        ),
      );
    }, timeoutMs);

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(
            `エンジンの子プロセスが失敗しました（code ${code}）。\n${stdout.slice(-2000)}\n${stderr.slice(-2000)}`,
          ),
        );
        return;
      }
      // 「> 」は送ったコマンド、「< 」はエンジンの行。段の先頭のコマンドで区切る。
      const lines: string[] = [];
      const byStep: string[][] = [];
      let stepIndex = -1;
      let sentInStep = 0;
      for (const raw of stdout.split('\n')) {
        if (raw.startsWith('> ')) {
          if (stepIndex < 0 || sentInStep === steps[stepIndex]!.send.length) {
            stepIndex += 1;
            sentInStep = 0;
            byStep.push([]);
          }
          sentInStep += 1;
        } else if (raw.startsWith('< ')) {
          const line = raw.slice(2);
          lines.push(line);
          byStep[stepIndex]?.push(line);
        }
      }
      resolve({ lines, byStep });
    });
  });
}


const manifest = hasArtifacts
  ? parseEngineManifest(JSON.parse(readFileSync(manifestPath, 'utf8')))
  : null;
const entries = manifest?.evals ?? [];

const threads = Math.max(1, Math.min(4, cpus().length));

/** 評価関数を渡して readyok まで進める段（`EvalDir` は絶対パス `/eval`。usi-runner.cjs が置く） */
const setupSteps = (fvScale: number, threadCount: number): Step[] => [
  { send: ['usi'], until: '^usiok', timeoutMs: 30_000 },
  {
    send: [
      'setoption name EvalDir value /eval',
      'setoption name EvalFile value nn.bin',
      `setoption name FV_SCALE value ${fvScale}`,
      `setoption name Threads value ${threadCount}`,
      'setoption name USI_Hash value 64',
      'setoption name BookFile value no_book',
      'isready',
    ],
    until: '^readyok',
    timeoutMs: 60_000,
  },
];

/** 後手の飛車を落とした局面（評価値が大きく、FV_SCALE による尺度の違いが見やすい。詰みは遠い） */
const IMBALANCED =
  'position sfen lnsgkgsnl/7b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1';
const DEPTH_STEP: Step = {
  send: [IMBALANCED, 'go depth 8'],
  until: '^bestmove',
  timeoutMs: 60_000,
};

/** 最後の info の評価値（cp）。mate なら null */
function lastCp(lines: string[]): number | null {
  let cp: number | null = null;
  for (const line of lines) {
    const match = /^info .*\bscore (cp|mate) ([+-]?\d+)/.exec(line);
    if (match) cp = match[1] === 'cp' ? Number(match[2]) : null;
  }
  return cp;
}

describe.skipIf(!hasArtifacts)('manifest（dist/engine/manifest.json）', () => {
  it('既定の評価関数が一覧にある', () => {
    expect(entries.map((entry) => entry.id)).toContain(manifest!.defaultId);
  });
});

describe.skipIf(!hasArtifacts).each(entries.map((entry) => [entry.id, entry] as const))(
  'やねうら王の WASM ビルドと評価関数 %s（dist/engine）',
  (_id, entry) => {
    const paths = engineAssetPaths(entry);
    const files = {
      js: join(distDir, paths.js),
      nnFile: join(distDir, paths.nn),
      progressFile: join(distDir, paths.progress),
    };

    it('manifest の sha256 と大きさが、置いてあるファイルと一致する', () => {
      expect(sha256(join(distDir, paths.js))).toBe(entry.engine.sha256.js);
      expect(sha256(join(distDir, paths.worker))).toBe(entry.engine.sha256.worker);
      expect(sha256(join(distDir, paths.wasm))).toBe(entry.engine.sha256.wasm);
      expect(statSync(files.nnFile).size).toBe(entry.nn.bytes);
      expect(sha256(files.nnFile)).toBe(entry.nn.sha256);
      expect(statSync(files.progressFile).size).toBe(entry.progress.bytes);
      expect(sha256(files.progressFile)).toBe(entry.progress.sha256);
      // MIT の許諾文を評価関数の隣に置く（prd/14 §5.5）
      expect(entry.license.file).toBeDefined();
      expect(readFileSync(join(distDir, entry.license.file!), 'utf8')).toContain(
        'MIT License',
      );

      // グルーは classic の Worker で importScripts して、この名前のグローバルから使う。
      expect(readFileSync(files.js, 'utf8')).toContain(entry.engine.exportName);
    });

    it('評価関数を /eval に置いて readyok になり、探索が bestmove と評価値を返す', async () => {
      const steps: Step[] = [
        ...setupSteps(entry.fvScale, threads),
        {
          send: ['position startpos moves 7g7f 3c3d 2g2f 4c4d', 'go movetime 300'],
          until: '^bestmove',
          timeoutMs: 30_000,
        },
        {
          send: ['go movetime 300 searchmoves 9g9f'],
          until: '^bestmove',
          timeoutMs: 30_000,
        },
      ];

      const { byStep } = await runSession(files, steps, 150_000);
      const [usi = [], ready = [], go = [], named = []] = byStep;

      // usi: エンジンの名乗りと、setoption で変えられる FV_SCALE の項目。
      expect(usi.some((line) => /^id name YaneuraOu/.test(line))).toBe(true);
      expect(usi.some((line) => /^option name FV_SCALE type spin\b/.test(line))).toBe(true);

      // isready: 評価関数（nn.bin と progress.bin）を読めた。
      expect(ready.some((line) => /^readyok/.test(line))).toBe(true);

      // go: 評価値つきの info と、指し手としての bestmove。
      const move = String.raw`(?:[1-9][a-i][1-9][a-i]\+?|[PLNSGBR]\*[1-9][a-i])`;
      expect(go.some((line) => /^info .*\bscore (?:cp|mate) [+-]?\d+/.test(line))).toBe(true);
      expect(go.find((line) => line.startsWith('bestmove'))).toMatch(
        new RegExp(`^bestmove ${move}`),
      );

      // searchmoves: 名指しした手だけを読む。
      expect(named.find((line) => line.startsWith('bestmove'))).toMatch(/^bestmove 9g9f\b/);
    }, 180_000);

    it('FV_SCALE を setoption で効かせられる（16 は 24 より評価値が約 1.5 倍大きい）', async () => {
      // 同じ局面を同じ深さで、FV_SCALE だけ変えて読む（1 スレッドで揺れを抑える）。
      // 配布物の eval_options.txt（FV_SCALE 24）を置いていないので、setoption の値がそのまま効くはず
      const run = async (fvScale: number) => {
        const { byStep } = await runSession(
          files,
          [...setupSteps(fvScale, 1), DEPTH_STEP],
          120_000,
        );
        return lastCp(byStep[2] ?? []);
      };
      expect(entry.fvScale).toBe(16);
      const at16 = await run(16);
      const at24 = await run(24);
      expect(at16).not.toBeNull();
      expect(at24).not.toBeNull();
      expect(Math.abs(at24!)).toBeGreaterThan(100);
      const ratio = Math.abs(at16!) / Math.abs(at24!);
      expect(ratio).toBeGreaterThan(1.2);
      expect(ratio).toBeLessThan(1.8);
    }, 260_000);
  },
);
