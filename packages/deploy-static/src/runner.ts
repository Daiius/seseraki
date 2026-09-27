// 本物の runner: システムの ssh / rsync を子プロセスとして呼ぶ。
// ライブラリ（ssh2 など）を使わないのは、~/.ssh/config・鍵・known_hosts の検証をそのまま効かせるため。

import { spawn } from 'node:child_process';
import type { Runner } from './deploy.js';

/**
 * 標準出力は受け取って返し、標準エラーは端末へそのまま流す。
 * パスフレーズやホスト鍵の確認は ssh が /dev/tty で直接行うので、標準入力をパイプにしても妨げない。
 */
export const spawnRunner: Runner = (step) =>
  new Promise((resolve, reject) => {
    const [cmd, ...args] = step.argv;
    if (cmd === undefined) {
      reject(new Error(`手順 ${step.label} の argv が空`));
      return;
    }
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'inherit'] });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({
        code: code ?? (signal !== null ? 128 : 1),
        stdout: Buffer.concat(chunks).toString('utf8'),
      });
    });
    child.stdin.on('error', () => {
      // 子が標準入力を読まずに終わった場合の EPIPE。終了コードの側で判断する。
    });
    child.stdin.end(step.stdin ?? '');
  });

/** 失敗しても投げない版（後片付け用）。 */
export async function runQuietly(argv: string[]): Promise<number> {
  return new Promise((resolve) => {
    const [cmd, ...args] = argv;
    if (cmd === undefined) return resolve(1);
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'ignore'] });
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 1));
  });
}
