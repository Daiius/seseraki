'use strict';
// 統合テストの子プロセス。グルーを読み込み、評価関数を渡して、筋書きどおりに USI のコマンドを送る。
// エンジンの出力は「< 」、送ったコマンドは「> 」を付けて標準出力へ流す。
//
// 別プロセスにしているのは 2 つの理由から。
// - isready などのコマンドは呼び出したスレッドを塞ぐ（その間はタイマーも動かない）。
//   親（vitest）の側から時間切れで止められるようにする。
// - エンジンは起動時に pthread の worker を作る。それが残ってもテストのプロセスが終われるよう、
//   最後に process.exit で確実に終える。
//
// 使い方: node usi-runner.cjs '<筋書きの JSON>'
//   { "js": グルーの絶対パス, "evalFile": nn.bin の絶対パス,
//     "steps": [{ "send": [コマンド...], "until": 待つ行の正規表現, "timeoutMs": 上限 }] }

const fs = require('node:fs');
const path = require('node:path');

const scenario = JSON.parse(process.argv[2]);

const fail = (message) => {
  console.error(`usi-runner: ${message}`);
  process.exit(1);
};

(async () => {
  const factory = require(scenario.js);
  if (typeof factory !== 'function') {
    fail(`グルーが関数を公開していません: ${scenario.js}`);
  }
  // worker と wasm はグルーと同じディレクトリから読ませる（名前はグルーが固定で持つ）。
  const dir = path.dirname(scenario.js);
  const engine = await factory({ locateFile: (file) => path.join(dir, file) });

  const lines = [];
  engine.addMessageListener((line) => {
    lines.push(line);
    process.stdout.write(`< ${line}\n`);
  });

  // 評価関数は仮想 FS のルートに置き、EvalDir / EvalFile で指す。
  engine.FS.writeFile('/nn.bin', fs.readFileSync(scenario.evalFile), {
    canOwn: true,
  });

  const waitFor = (pattern, from, timeoutMs) =>
    new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const timer = setInterval(() => {
        if (lines.slice(from).some((line) => pattern.test(line))) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() - startedAt > timeoutMs) {
          clearInterval(timer);
          reject(new Error(`${timeoutMs}ms 待っても ${pattern} が来ません`));
        }
      }, 20);
    });

  for (const step of scenario.steps) {
    const from = lines.length;
    for (const command of step.send) {
      process.stdout.write(`> ${command}\n`);
      engine.postMessage(command);
    }
    await waitFor(new RegExp(step.until), from, step.timeoutMs);
  }

  try {
    if (typeof engine.terminate === 'function') engine.terminate();
  } catch {
    // 終了処理の失敗は結果に影響させない（下の process.exit で終える）。
  }
  process.exit(0);
})().catch((error) =>
  fail(error instanceof Error ? error.stack || error.message : String(error)),
);
