# engine-wasm

ブラウザ解析に使う将棋エンジン（[やねうら王](https://github.com/yaneurao/YaneuraOu)）の **WebAssembly ビルド**と、
評価関数（**つようら王11mini / つようら王11micro**）を、web が静的ファイルとして配れる形に揃えるパッケージ。
設計は [prd/14](../../prd/14-multi-user.md) §5.5（小見出し「評価関数の選択」）、置き場所は [prd/02](../../prd/02-architecture.md) §5。

- **このパッケージが持つのはビルドの手順だけ。** エンジンのソースも成果物もコミットしない。
- **上流に手を入れない。** 上流の固定したコミットを、上流の Makefile でそのままビルドする（パッチは無い）。
- **評価関数の型（arch）ごとにエンジンを 1 本ビルドする。** arch はコンパイル時に固定なので、mini（`SFNN_ka2_4096_8_64_progress8`）と
  micro（`SFNN_ka2_2048_8_64_progress8`）は別のエンジンになる（EDITION が同じ評価関数はエンジンを共有する）。
- web からの読み込み（Web Worker のラッパー・COOP/COEP・配信先への配置）は、このパッケージの外で行う。

## ライセンス

**このパッケージだけが GPL-3.0**（[LICENSE](./LICENSE)。上流のやねうら王の `LICENSE` と同じもの）。
リポジトリのほかの部分には及ばない。

- エンジンはアプリのバンドルに混ぜず、**別ファイルとして Worker から読み込む**。アプリとは USI のテキストを
  やり取りするだけの別プログラムとして扱う。
- manifest の型と検証は [`packages/shared`](../shared/src/engine-manifest.ts) にある。web / server が
  このパッケージから TypeScript を import しないようにするため（ここは形に合う JSON を出すだけ）。
- **エンジン（GPL-3.0）の対応ソースの示し方**: 配るバイナリは、[UPSTREAM](./UPSTREAM) の `YANEURAOU_REPO` の `YANEURAOU_SHA` を、
  `EMSDK_IMAGE` の中で上流の Makefile（`make clean tournament COMPILER=em++ TARGET_CPU=WASM YANEURAOU_EDITION=<EDITION> …`）で
  ビルドしたもの。パッチは無い。同じ値は配信物の `manifest.json`（各エントリの `engine.upstreamSha` / `engine.emsdk` / `engine.edition`）
  にも入るので、配った物からソースのコミットとビルド手順を辿れる。ビルドスクリプトはこのディレクトリの `build.sh`。
- **評価関数（つようら王11mini / micro）は MIT License**。エンジンとは別の著作物で、作者（やねうらお）が 2026-10-14 に公開した
  （出典: <https://yaneuraou.yaneu.com/2026/10/14/tsuyou-11-mini-micro-released-under-mit-license/>）。
  配布物に許諾文が入っていないので、著作権表示と MIT の許諾文を [`eval-licenses/tsuyo11.txt`](./eval-licenses/tsuyo11.txt) に置き、
  配信物の評価関数の隣（`eval/license-<内容ハッシュ>.txt`）に同梱する。設定ページのライセンス表示にも出す。

## ビルド

要るもの: bash・git・curl・sha256sum・cmp・Docker（`EMSDK_IMAGE` のイメージを先に pull しておく）。

```bash
pnpm engine:build        # リポジトリのルートで。エンジンのビルド → 評価関数の取得を順に流す
```

個別に流すとき（引数を渡すとき）はパッケージのスクリプトを直接呼ぶ。

```bash
pnpm --filter engine-wasm engine:build --check   # 何をするかと現状を表示して終わる
pnpm --filter engine-wasm engine:build           # エンジン（arch ごとに数分）
pnpm --filter engine-wasm engine:build --force   # 揃っていても作り直す
pnpm --filter engine-wasm engine:eval --check
pnpm --filter engine-wasm engine:eval            # 評価関数（ダウンロード 約 5.6MB + 約 3.1MB → 照合 → 展開 → 照合）
pnpm --filter engine-wasm engine:eval --from tsuyo11mini=/path/to/dir   # 手元の nn.bin・progress.bin を使う（照合は同じ）
pnpm --filter engine-wasm test                   # 成果物を node で動かして確かめる
```

- **どちらも冪等。** UPSTREAM の値が同じで成果物が揃っていれば作り直さない（`--force` で作り直す）。
- **固定値は [UPSTREAM](./UPSTREAM) の 1 か所**（上流のコミット・Emscripten のイメージ・評価関数の一覧と既定・
  評価関数ごとの EDITION・公開名・`FV_SCALE`・配布物の URL と大きさと sha256・中身の `nn.bin` / `progress.bin` の大きさと sha256・
  ライセンスと出典）。評価関数ごとの値は `EVAL_<id を大文字にしたもの>_<項目>` に書く。スクリプトはここから読む。
  更新するときはこのファイルだけを変えて流し直す。
- 評価関数は、**アーカイブと中身（`nn.bin`・`progress.bin`）の大きさと sha256 が UPSTREAM と一致しなければ置かない**（`--from` でも中身は同じく照合する）。
- **アーカイブから取り出すのは `nn.bin` と `progress.bin` だけ。** 中の `eval_options.txt`（`FV_SCALE 24`）・`tag.json`・`banner.png` は置かない（下の「落とし穴」）。
- 7z の展開は、ホストに 7z があればそれを、無ければ使い捨てコンテナ（`EVAL_EXTRACT_IMAGE` に `p7zip-full` を入れる）を使う。
- Docker が無い・接続できない・イメージが手元に無いときは、何もせずに理由を出して止まる（イメージを勝手に pull しない）。
- 作業場所は `.cache/`（上流の checkout・ダウンロードしたアーカイブ・エンジンごとの直近のビルドの記録 `engine-<名前>.stamp`）。消してよい。

### なぜ script の名前が `build` ではないか

ルートの `pnpm build`（`pnpm -r build`）から Docker が走らないようにするため。エンジンのビルドは明示的に流す。

### なぜ上流の `script/wasm_build.js` を使わないか

上流の `wasm_build.js` には SFNN（つようら王11 の arch）のビルド対象が無い。`build.sh` は wasm_build.js が使うのと同じ make の行を、
EDITION・出力先・公開名（`EM_EXPORT_NAME`）・初期メモリ（`EM_INITIAL_MEMORY_SIZE`）を変えて emsdk のコンテナで直接流す。
arch のヘッダは上流の Makefile が `nnue_arch_gen.py` で生成するので、`PYTHON=python3` を渡す。

## 成果物（`dist/engine/`）

web がこのディレクトリをそのまま静的ファイルとして配る。**内容が変わればパスが変わる**ので、長期キャッシュに載せられる
（`manifest.json` だけは同じパスで中身が変わる）。

```
dist/engine/
  manifest.json
  <mini のエンジンの内容ハッシュ>/
    yaneuraou.sfnn_ka2_4096_8_64_progress8.js         グルー
    yaneuraou.sfnn_ka2_4096_8_64_progress8.worker.js  pthread の worker
    yaneuraou.sfnn_ka2_4096_8_64_progress8.wasm
  <micro のエンジンの内容ハッシュ>/
    yaneuraou.sfnn_ka2_2048_8_64_progress8.{js,worker.js,wasm}
  eval/
    nn-<sha256 の先頭 16 桁>.bin         評価関数の本体（mini と micro で 1 つずつ）
    progress-<sha256 の先頭 16 桁>.bin   進行度（mini と micro で同じものを共有）
    license-<sha256 の先頭 16 桁>.txt    評価関数の MIT の許諾文
```

- グルーが `.worker.js` と `.wasm` の**名前を固定で持つ**ので、ファイル名は変えず、ディレクトリ名に内容ハッシュを入れる。
- `dist/engine/` には**今のビルドと今の評価関数だけ**を残す。**以前のものを消すのは `manifest.json` を切り替えた後**
  ——新しいものを一時の名前で置いて確かめ、名前を付け替え、manifest を書き、最後に manifest が指さなくなったものを消す。
  途中で失敗しても、残っている manifest が指すファイルは残る。
- `manifest.json` は**すべてのエンジンとすべての評価関数が UPSTREAM の今の値で揃ったときだけ**書く。1 つでも合っていなければ置かない
  （このときファイルは消さない）。

`manifest.json` の形（型と検証は `shared` の `engineManifestSchema`）:

```json
{
  "defaultId": "tsuyo11mini",
  "evals": [
    {
      "id": "tsuyo11mini",
      "name": "つようら王11mini",
      "engine": {
        "buildId": "<上流 SHA の先頭 8 桁>-<wasm の sha256 の先頭 12 桁>",
        "upstreamSha": "<上流のコミット>",
        "emsdk": "emscripten/emsdk:3.1.43",
        "edition": "YANEURAOU_ENGINE_SFNN_ka2_4096_8_64_progress8",
        "exportName": "YaneuraOu_SFNN_ka2_4096",
        "dir": "<エンジンの内容ハッシュ>",
        "files": { "js": "…", "worker": "…", "wasm": "…" },
        "sha256": { "js": "…", "worker": "…", "wasm": "…" }
      },
      "nn": { "file": "eval/nn-….bin", "bytes": 7711372, "sha256": "…" },
      "progress": { "file": "eval/progress-….bin", "bytes": 1003104, "sha256": "…" },
      "fvScale": 16,
      "license": { "name": "MIT", "sourceUrl": "https://…", "file": "eval/license-….txt" }
    },
    { "id": "tsuyo11micro", "…": "…" }
  ]
}
```

- エントリの `engine.buildId`・`nn.sha256`（来歴の `evalHash`）・`fvScale` は解析の来歴に記録する値（[prd/14](../../prd/14-multi-user.md) §5.9）。
  `progress.bin` は同じ配布物の一部で、manifest の sha256 で照合するだけ（来歴には載せない）。
- `dir`・`files`・`nn.file`・`progress.file`・`license.file` は `manifest.json` の置き場からの相対。
- `defaultId` は端末で選んでいない（または配っていない id を選んでいた）ときに使う評価関数。

## エンジンの使い方（node / ブラウザ共通の骨子）

```js
const engine = await YaneuraOu_SFNN_ka2_4096({ locateFile: (file) => baseUrl + file });
engine.addMessageListener((line) => { /* USI の 1 行 */ });
engine.FS.mkdir('/eval');
engine.FS.writeFile('/eval/nn.bin', new Uint8Array(nn), { canOwn: true });
engine.FS.writeFile('/eval/progress.bin', new Uint8Array(progress), { canOwn: true });
engine.postMessage('usi');
// setoption name EvalDir value /eval / EvalFile value nn.bin / FV_SCALE value 16
// / Threads value <n> / USI_Hash value 64 / BookFile value no_book → isready
```

node で実際に動かす例は [`test/usi-runner.cjs`](./test/usi-runner.cjs)。

## 落とし穴

- 🔴 **`EvalDir` は絶対パス `/eval` にする（`.` にしない）。** 上流の WASM は `nn.bin` を `EvalDir` そのままのパスで、
  `progress.bin` を「実行ファイルのフォルダ + `EvalDir`」で探す。`.` だと `progress.bin` が見つからず、`isready` で**黙って終了する**。
  上流のパスの結合は絶対パスをそのまま返すので、`/eval` なら両方とも見つかる（パッチは要らない）。
- 🔴 **`FV_SCALE` は 16 を `setoption` で渡す**（手元 worker・悪手判定の閾値と尺度を揃える。作者の推奨は 24 だが採らない。prd/14 §5.5）。
  SFNN を make で直接ビルドする形では焼き込みは無く、`setoption` が効く（統合テストが 16 と 24 で評価値の比を確かめる）。
- 🔴 **`isready` のたびに仮想 FS の `engine_options.txt` と `<EvalDir>/eval_options.txt` を読む。** そこで上書きされた
  オプションは固定され、`setoption` が効かなくなる。配布物の `eval_options.txt` は `FV_SCALE 24` なので、
  評価関数のディレクトリには `nn.bin` と `progress.bin` だけを置く。
- **rootless の Docker では `-u $(id -u):$(id -g)` を付けない**（付けると EACCES で落ちる）。`build.sh` は rootless かどうかを見て切り替える。
- **エンジン本体をバンドラ（Vite）に通さない。** グルーはグローバルの名前（`exportName`）と、隣にある
  `.worker.js` / `.wasm` の名前に依存する。静的ファイルとして置く。公開名は arch ごとに別にしてある（同じ Worker に 2 本読まない前提だが、取り違えを名前で防ぐ）。
- **Worker の中で読み込むときは `mainScriptUrlOrBlob` にグルーの URL を渡す。** 渡さないと pthread の worker が
  エンジン本体を読めない。`.worker.js` と `.wasm` の場所は `locateFile` で決める。
- **コマンドは呼び出したスレッドで同期に実行される。** `isready` は評価関数を読み終えるまで塞ぐので、
  ブラウザではメインスレッドに置かない（統合テストが子プロセスに分けているのも同じ理由）。
- **起動時に pthread の worker を 32 本作る。** node では明示的に終えないとプロセスが残る（`terminate()` と `process.exit`）。
- **このパッケージの `package.json` に `"type": "module"` を付けない。** グルーは CommonJS で、`dist/` の `.js` が
  ESM として読まれると node で動かなくなる（vitest の設定が `.mts` なのはこのため）。
- **Emscripten のイメージはタグで固定している**（ダイジェストではない）。実際にできた物は `manifest.json` の
  sha256 と `buildId` で識別する。
