// ブラウザ解析のエンジンのホスト（prd/14-multi-user.md §5.5・§5.11）。
//
// 🔒 **classic の Web Worker のスクリプト。import / export を書かない・バンドラに通さない。**
// エンジンのグルーは `importScripts` で読み、グローバルに生える関数（manifest の `exportName`）を呼ぶ。
// Vite プラグイン（./index.ts）が、このファイルを変換せずそのまま配る。
//
// この Worker の中にエンジン（WASM）がいて、エンジンはさらに pthread の Worker を作る（入れ子の Worker）。
// エンジンのコマンドは呼び出したスレッドで同期に実行され、`isready` は評価関数を読み終えるまで塞ぐので、
// メインスレッドには置けない。
//
// メインスレッドとのやり取り（`src/lib/browserAnalysis/engineHost.ts` と対）:
//   受ける: { type: 'init', glueUrl, baseUrl, exportName, evalUrl, evalBytes, evalSha256 }
//           { type: 'cmd', line }   USI の 1 行
//           { type: 'quit' }
//   送る:   { type: 'download', loaded, total }   評価関数の受信バイト数
//           { type: 'ready' }                     エンジンを起動し、評価関数を仮想 FS に置いた
//           { type: 'line', line }                エンジンの出力 1 行
//           { type: 'dead', message }             エンジンが死んだ・起動できなかった（以後は何も送らない）
'use strict';

var LOG = '[browser-analysis] host:';
var engine = null;
var dead = false;

function messageOf(thrown) {
  if (thrown instanceof Error) return thrown.message;
  // エンジンは終了時に Error でない値（{ name: 'ExitStatus', message, status }）を投げる
  if (thrown && typeof thrown === 'object' && typeof thrown.message === 'string') {
    return thrown.message;
  }
  return String(thrown);
}

function die(thrown) {
  if (dead) return;
  dead = true;
  var message = messageOf(thrown);
  console.warn(LOG, 'dead:', message);
  self.postMessage({ type: 'dead', message: message });
}

function toHex(buffer) {
  var bytes = new Uint8Array(buffer);
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    hex += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  }
  return hex;
}

// 評価関数を受信する。大きさが分かっているので、その大きさのバッファへ直接詰める（二重に持たない）
async function downloadEval(url, expectedBytes, expectedSha256) {
  var response = await fetch(url, { credentials: 'same-origin' });
  if (!response.ok) {
    throw new Error('評価関数を取得できません (' + response.status + ')');
  }
  var bytes = new Uint8Array(expectedBytes);
  var loaded = 0;
  var lastReportedAt = 0;
  var report = function (force) {
    var now = Date.now();
    if (!force && now - lastReportedAt < 200) return;
    lastReportedAt = now;
    self.postMessage({ type: 'download', loaded: loaded, total: expectedBytes });
  };
  if (response.body && response.body.getReader) {
    var reader = response.body.getReader();
    for (;;) {
      var chunk = await reader.read();
      if (chunk.done) break;
      if (loaded + chunk.value.length > expectedBytes) {
        throw new Error('評価関数の大きさが manifest と違います');
      }
      bytes.set(chunk.value, loaded);
      loaded += chunk.value.length;
      report(false);
    }
  } else {
    var whole = new Uint8Array(await response.arrayBuffer());
    if (whole.length !== expectedBytes) {
      throw new Error('評価関数の大きさが manifest と違います');
    }
    bytes = whole;
    loaded = whole.length;
  }
  if (loaded !== expectedBytes) {
    throw new Error(
      '評価関数の大きさが manifest と違います (' + loaded + ' / ' + expectedBytes + ')',
    );
  }
  report(true);
  // 来歴に記録するハッシュと、実際に使う評価関数を一致させる
  if (self.crypto && self.crypto.subtle) {
    var digest = toHex(await self.crypto.subtle.digest('SHA-256', bytes));
    if (digest !== expectedSha256) {
      throw new Error('評価関数のハッシュが manifest と違います');
    }
  }
  return bytes;
}

async function init(message) {
  console.info(LOG, 'loading engine', message.glueUrl);
  // 評価関数の受信は、エンジンの起動と並行に進める
  var evalPromise = downloadEval(
    message.evalUrl,
    message.evalBytes,
    message.evalSha256,
  );
  // 先に失敗しても「捕まえていない拒否」にしない（下の await で受ける）
  evalPromise.catch(function () {});

  importScripts(message.glueUrl);
  var factory = self[message.exportName];
  if (typeof factory !== 'function') {
    throw new Error('エンジンのグルーが ' + message.exportName + ' を公開していません');
  }
  var instance = await factory({
    // `.worker.js` と `.wasm` はグルーと同じディレクトリから読ませる（名前はグルーが固定で持つ）
    locateFile: function (file) {
      return message.baseUrl + file;
    },
    // Worker の中ではグルーが自分の URL を知らない。渡さないと pthread の Worker がエンジン本体を読めない
    mainScriptUrlOrBlob: message.glueUrl,
    onAbort: function (what) {
      die('エンジンが異常終了しました: ' + messageOf(what));
    },
    onExit: function (status) {
      die('エンジンが終了しました (' + status + ')');
    },
  });
  console.info(LOG, 'engine instantiated');
  instance.addMessageListener(function (line) {
    if (!dead) self.postMessage({ type: 'line', line: line });
  });

  var bytes = await evalPromise;
  // 評価関数は仮想 FS のルートに置き、EvalDir / EvalFile で指す。ほかのファイルは置かない
  // （isready のたびに読まれる eval_options.txt があると、オプションが固定される）
  instance.FS.writeFile('/nn.bin', bytes, { canOwn: true });
  console.info(LOG, 'eval written', bytes.length);

  engine = instance;
  if (!dead) self.postMessage({ type: 'ready' });
}

self.addEventListener('error', function (event) {
  die(event.error || event.message || 'worker error');
});
self.addEventListener('unhandledrejection', function (event) {
  // 死とは決めつけない（グルーの内部の拒否でも来る）。本当に止まっていれば、応答の時間切れで分かる
  console.warn(LOG, 'unhandled rejection:', messageOf(event.reason));
});

self.onmessage = function (event) {
  var message = event.data;
  if (!message || typeof message.type !== 'string') return;
  if (message.type === 'init') {
    init(message).catch(die);
    return;
  }
  if (message.type === 'quit') {
    try {
      if (engine && typeof engine.terminate === 'function') engine.terminate();
    } catch (error) {
      // 終了処理の失敗は無視する（この後 Worker ごと閉じる）
    }
    dead = true;
    self.close();
    return;
  }
  if (message.type === 'cmd') {
    if (dead || !engine) {
      die('エンジンが動いていません');
      return;
    }
    try {
      // ⚠ 不正な指し手を渡すとエンジンはプロセスごと終了し、この呼び出しが同期で投げる
      engine.postMessage(message.line);
    } catch (error) {
      die(error);
    }
  }
};
