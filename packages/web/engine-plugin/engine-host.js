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
//   受ける: { type: 'init', glueUrl, baseUrl, exportName, evalDir, pathSegmentPattern,
//             evalFiles: [{ url, bytes, sha256, path }] }
//           { type: 'cmd', line }   USI の 1 行
//           { type: 'quit' }
//   送る:   { type: 'download', loaded, total }   評価関数の受信バイト数（全ファイルの合計）
//           { type: 'ready' }                     エンジンを起動し、評価関数を仮想 FS に置いた
//           { type: 'line', line }                エンジンの出力 1 行
//           { type: 'dead', message }             エンジンが死んだ・起動できなかった（以後は何も送らない）
//
// 評価関数のファイル（nn.bin・progress.bin）は仮想 FS の evalDir（/eval）の直下に置く（`path`）。
// evalDir と、置き場の名前に許す形（shared の ENGINE_PATH_SEGMENT_PATTERN）は init の本文で受け取る（import できないため）。
// ⚠ EvalDir は絶対パス /eval にする（engineHost.ts）。`.` だと上流は progress.bin を「実行ファイルのフォルダ + EvalDir」から
// 探して見つけられず、isready で黙って終了する。ほかのファイル（eval_options.txt）は置かない（オプションが固定される）。
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

// 評価関数のファイルをすべて受信する。進捗は全ファイルの合計で伝える。
// 大きさが分かっているので、その大きさのバッファへ直接詰める（二重に持たない）
async function downloadEvalFiles(files) {
  var total = 0;
  for (var i = 0; i < files.length; i++) total += files[i].bytes;
  var loadedByFile = files.map(function () {
    return 0;
  });
  var lastReportedAt = 0;
  var report = function (force) {
    var now = Date.now();
    if (!force && now - lastReportedAt < 200) return;
    lastReportedAt = now;
    var loaded = 0;
    for (var j = 0; j < loadedByFile.length; j++) loaded += loadedByFile[j];
    self.postMessage({ type: 'download', loaded: loaded, total: total });
  };

  var downloadOne = async function (file, index) {
    var name = file.path;
    var response = await fetch(file.url, { credentials: 'same-origin' });
    if (!response.ok) {
      throw new Error('評価関数を取得できません (' + name + ' ' + response.status + ')');
    }
    var bytes = new Uint8Array(file.bytes);
    var loaded = 0;
    if (response.body && response.body.getReader) {
      var reader = response.body.getReader();
      for (;;) {
        var chunk = await reader.read();
        if (chunk.done) break;
        if (loaded + chunk.value.length > file.bytes) {
          throw new Error('評価関数の大きさが manifest と違います (' + name + ')');
        }
        bytes.set(chunk.value, loaded);
        loaded += chunk.value.length;
        loadedByFile[index] = loaded;
        report(false);
      }
    } else {
      var whole = new Uint8Array(await response.arrayBuffer());
      if (whole.length !== file.bytes) {
        throw new Error('評価関数の大きさが manifest と違います (' + name + ')');
      }
      bytes = whole;
      loaded = whole.length;
      loadedByFile[index] = loaded;
    }
    if (loaded !== file.bytes) {
      throw new Error(
        '評価関数の大きさが manifest と違います (' + name + ' ' + loaded + ' / ' + file.bytes + ')',
      );
    }
    // 来歴に記録するハッシュと、実際に使う評価関数を一致させる（crypto.subtle が無ければ init が先に止めている）
    var digest = toHex(await self.crypto.subtle.digest('SHA-256', bytes));
    if (digest !== file.sha256) {
      throw new Error('評価関数のハッシュが manifest と違います (' + name + ')');
    }
    return bytes;
  };

  var results = await Promise.all(
    files.map(function (file, index) {
      return downloadOne(file, index);
    }),
  );
  report(true);
  return results;
}

async function init(message) {
  console.info(LOG, 'loading engine', message.glueUrl);
  var evalFiles = message.evalFiles;
  if (!Array.isArray(evalFiles) || evalFiles.length === 0) {
    throw new Error('評価関数のファイルが指定されていません');
  }
  if (typeof message.pathSegmentPattern !== 'string' || message.pathSegmentPattern === '') {
    throw new Error('置き場の名前の形が指定されていません');
  }
  var segment = new RegExp('^(?:' + message.pathSegmentPattern + ')$');
  var evalDir = String(message.evalDir);
  // 置き場のディレクトリはルート直下の 1 階層だけ（/eval）
  if (evalDir.charAt(0) !== '/' || !segment.test(evalDir.slice(1))) {
    throw new Error('評価関数のディレクトリが不正です: ' + evalDir);
  }
  for (var i = 0; i < evalFiles.length; i++) {
    // 置き場は <evalDir>/<名前> だけ（ほかの場所に書かせない）
    var filePath = String(evalFiles[i].path);
    if (
      filePath.slice(0, evalDir.length + 1) !== evalDir + '/' ||
      !segment.test(filePath.slice(evalDir.length + 1))
    ) {
      throw new Error('評価関数の置き場が不正です: ' + evalFiles[i].path);
    }
  }
  // 🔒 評価関数を照合できない環境（crypto.subtle が無い）では止める。照合を飛ばして読み込むと、
  // 来歴のハッシュと実際に使った評価関数が食い違ったまま結果が保存されうる。ダウンロードの前に断る
  if (!self.crypto || !self.crypto.subtle) {
    throw new Error('この環境では評価関数を照合できません（crypto.subtle がありません）');
  }
  // 評価関数の受信は、エンジンの起動と並行に進める
  var evalPromise = downloadEvalFiles(evalFiles);
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

  var contents = await evalPromise;
  // 評価関数は仮想 FS の evalDir（/eval）に置き、EvalDir / EvalFile で指す
  instance.FS.mkdir(evalDir);
  for (var k = 0; k < evalFiles.length; k++) {
    instance.FS.writeFile(evalFiles[k].path, contents[k], { canOwn: true });
    console.info(LOG, 'eval written', evalFiles[k].path, contents[k].length);
  }

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
