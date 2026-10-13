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
  js: string,
  evalFile: string,
  steps: Step[],
  timeoutMs: number,
): Promise<Session> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [runnerPath, JSON.stringify({ js, evalFile, steps })],
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

describe.skipIf(!hasArtifacts)(
  'やねうら王の WASM ビルド（dist/engine）',
  () => {
    it('manifest の sha256 と大きさが、置いてあるファイルと一致する', () => {
      const manifest = parseEngineManifest(
        JSON.parse(readFileSync(manifestPath, 'utf8')),
      );
      const paths = engineAssetPaths(manifest);

      expect(sha256(join(distDir, paths.js))).toBe(manifest.engine.sha256.js);
      expect(sha256(join(distDir, paths.worker))).toBe(
        manifest.engine.sha256.worker,
      );
      expect(sha256(join(distDir, paths.wasm))).toBe(
        manifest.engine.sha256.wasm,
      );
      expect(statSync(join(distDir, paths.eval)).size).toBe(
        manifest.eval.bytes,
      );
      expect(sha256(join(distDir, paths.eval))).toBe(manifest.eval.sha256);

      // グルーは classic の Worker で importScripts して、この名前のグローバルから使う。
      expect(readFileSync(join(distDir, paths.js), 'utf8')).toContain(
        manifest.engine.exportName,
      );
    });

    it('評価関数を渡して readyok になり、探索が bestmove と評価値を返す', async () => {
      const manifest = parseEngineManifest(
        JSON.parse(readFileSync(manifestPath, 'utf8')),
      );
      const paths = engineAssetPaths(manifest);
      const threads = Math.max(1, Math.min(4, cpus().length));

      const steps: Step[] = [
        { send: ['usi'], until: '^usiok', timeoutMs: 30_000 },
        {
          send: [
            'setoption name EvalDir value .',
            'setoption name EvalFile value nn.bin',
            `setoption name FV_SCALE value ${manifest.fvScale}`,
            `setoption name Threads value ${threads}`,
            'setoption name USI_Hash value 64',
            'setoption name BookFile value no_book',
            'isready',
          ],
          until: '^readyok',
          timeoutMs: 60_000,
        },
        {
          send: [
            'position startpos moves 7g7f 3c3d 2g2f 4c4d',
            'go movetime 300',
          ],
          until: '^bestmove',
          timeoutMs: 30_000,
        },
        {
          send: ['go movetime 300 searchmoves 9g9f'],
          until: '^bestmove',
          timeoutMs: 30_000,
        },
      ];

      const { byStep } = await runSession(
        join(distDir, paths.js),
        join(distDir, paths.eval),
        steps,
        150_000,
      );
      const [usi = [], ready = [], go = [], named = []] = byStep;

      // usi: エンジンの名乗りと、FV_SCALE の既定値（評価関数を埋め込まない対象は 16 のまま）。
      expect(usi.some((line) => /^id name YaneuraOu/.test(line))).toBe(true);
      const fvScaleOption = usi.find((line) =>
        /^option name FV_SCALE /.test(line),
      );
      expect(fvScaleOption).toMatch(
        new RegExp(`\\bdefault ${manifest.fvScale}\\b`),
      );

      // isready: 評価関数を読めた。
      expect(ready.some((line) => /^readyok/.test(line))).toBe(true);

      // go: 評価値つきの info と、指し手としての bestmove。
      const move = String.raw`(?:[1-9][a-i][1-9][a-i]\+?|[PLNSGBR]\*[1-9][a-i])`;
      expect(
        go.some((line) => /^info .*\bscore (?:cp|mate) [+-]?\d+/.test(line)),
      ).toBe(true);
      expect(go.find((line) => line.startsWith('bestmove'))).toMatch(
        new RegExp(`^bestmove ${move}`),
      );

      // searchmoves: 名指しした手だけを読む。
      expect(named.find((line) => line.startsWith('bestmove'))).toMatch(
        /^bestmove 9g9f\b/,
      );
    }, 180_000);
  },
);
