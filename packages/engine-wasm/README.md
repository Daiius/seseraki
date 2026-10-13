# engine-wasm

ブラウザ解析に使う将棋エンジン（[やねうら王](https://github.com/yaneurao/YaneuraOu)）の **WebAssembly ビルド**と、
評価関数（水匠5）を、web が静的ファイルとして配れる形に揃えるパッケージ。
設計は [prd/14](../../prd/14-multi-user.md) §5.5、置き場所は [prd/02](../../prd/02-architecture.md) §5。

- **このパッケージが持つのはビルドの手順だけ。** エンジンのソースも成果物もコミットしない。
- **上流に手を入れない。** 上流の固定したコミットを、上流のビルド手順（`script/wasm_build.js`）でそのままビルドする。
- web からの読み込み（Web Worker のラッパー・COOP/COEP・配信先への配置）は、このパッケージの外で行う。

## ライセンス

**このパッケージだけが GPL-3.0**（[LICENSE](./LICENSE)。上流のやねうら王の `LICENSE` と同じもの）。
リポジトリのほかの部分には及ばない。

- エンジンはアプリのバンドルに混ぜず、**別ファイルとして Worker から読み込む**。アプリとは USI のテキストを
  やり取りするだけの別プログラムとして扱う。
- manifest の型と検証は [`packages/shared`](../shared/src/engine-manifest.ts) にある。web / server が
  このパッケージから TypeScript を import しないようにするため（ここは形に合う JSON を出すだけ）。
- **対応ソースの示し方**: 配るバイナリは、[UPSTREAM](./UPSTREAM) の `YANEURAOU_REPO` の `YANEURAOU_SHA` を、
  `EMSDK_IMAGE` の中で `node script/wasm_build.js <BUILD_TARGET>` としてビルドしたもの。パッチは無い。
  同じ値は配信物の `manifest.json`（`engine.upstreamSha` / `engine.emsdk` / `engine.target`）にも入るので、
  配った物からソースのコミットとビルド手順を辿れる。ビルドスクリプトはこのディレクトリの `build.sh`。
- 評価関数（水匠5）はエンジンとは別の著作物で、上流のリリースから取得する（`EVAL_URL`）。

## ビルド

要るもの: bash・git・curl・sha256sum・Docker（`EMSDK_IMAGE` のイメージを先に pull しておく）。

```bash
pnpm engine:build        # リポジトリのルートで。エンジンのビルド → 評価関数の取得を順に流す
```

個別に流すとき（引数を渡すとき）はパッケージのスクリプトを直接呼ぶ。

```bash
pnpm --filter engine-wasm engine:build --check   # 何をするかと現状を表示して終わる
pnpm --filter engine-wasm engine:build           # エンジン（約 2 分）
pnpm --filter engine-wasm engine:build --force   # 揃っていても作り直す
pnpm --filter engine-wasm engine:eval --check
pnpm --filter engine-wasm engine:eval            # 評価関数（ダウンロード約 24MB → 展開 → 照合）
pnpm --filter engine-wasm engine:eval --from /path/to/nn.bin   # 手元の nn.bin を使う（照合は同じ）
pnpm --filter engine-wasm test                   # 成果物を node で動かして確かめる
```

- **どちらも冪等。** UPSTREAM の値が同じで成果物が揃っていれば作り直さない（`--force` で作り直す）。
- **固定値は [UPSTREAM](./UPSTREAM) の 1 か所**（上流のコミット・Emscripten のイメージ・ビルド対象・評価関数の URL と
  sha256）。スクリプトはここから読む。更新するときはこのファイルだけを変えて流し直す。
- 評価関数は **sha256 と大きさが UPSTREAM と一致しなければ置かない**（`--from` でも同じ）。
- 7z の展開は、ホストに 7z があればそれを、無ければ使い捨てコンテナ（`EVAL_EXTRACT_IMAGE` に `p7zip-full` を入れる）を使う。
- Docker が無い・接続できない・イメージが手元に無いときは、何もせずに理由を出して止まる（イメージを勝手に pull しない）。
- 作業場所は `.cache/`（上流の checkout・ダウンロードしたアーカイブ・直近のビルドの記録）。消してよい。

### なぜ script の名前が `build` ではないか

ルートの `pnpm build`（`pnpm -r build`）から Docker が走らないようにするため。エンジンのビルドは明示的に流す。

## 成果物（`dist/engine/`）

web がこのディレクトリをそのまま静的ファイルとして配る。**内容が変わればパスが変わる**ので、長期キャッシュに載せられる
（`manifest.json` だけは同じパスで中身が変わる）。

```
dist/engine/
  manifest.json
  <エンジンの内容ハッシュ>/
    yaneuraou.halfkp.noeval.js         グルー
    yaneuraou.halfkp.noeval.worker.js  pthread の worker
    yaneuraou.halfkp.noeval.wasm
  eval/
    nn-<sha256 の先頭 16 桁>.bin        評価関数
```

- グルーが `.worker.js` と `.wasm` の**名前を固定で持つ**ので、ファイル名は変えず、ディレクトリ名に内容ハッシュを入れる。
- `dist/engine/` には**今のビルドと今の評価関数だけ**を残す。**以前のものを消すのは `manifest.json` を切り替えた後**
  ——新しいものを一時の名前で置いて確かめ、名前を付け替え、manifest を書き、最後に以前のものを消す。
  途中で失敗しても、残っている manifest が指すファイルは残る。
- `manifest.json` はエンジンと評価関数が**両方とも UPSTREAM の今の値で揃ったときだけ**書く。片方が合っていなければ置かない
  （このときファイルは消さない）。

`manifest.json` の形（型と検証は `shared` の `engineManifestSchema`）:

```json
{
  "engine": {
    "buildId": "<上流 SHA の先頭 8 桁>-<wasm の sha256 の先頭 12 桁>",
    "upstreamSha": "<上流のコミット>",
    "emsdk": "emscripten/emsdk:3.1.43",
    "target": "halfkp.noeval",
    "exportName": "YaneuraOu_HalfKP_noeval",
    "dir": "<エンジンの内容ハッシュ>",
    "files": { "js": "…", "worker": "…", "wasm": "…" },
    "sha256": { "js": "…", "worker": "…", "wasm": "…" }
  },
  "eval": { "name": "Suisho5", "file": "eval/nn-….bin", "bytes": 64217066, "sha256": "…" },
  "fvScale": 16
}
```

- `buildId`・`eval.sha256`・`fvScale` は解析の来歴に記録する値（[prd/14](../../prd/14-multi-user.md) §5.9）。
- `dir`・`files`・`eval.file` は `manifest.json` の置き場からの相対。

## エンジンの使い方（node / ブラウザ共通の骨子）

```js
const engine = await YaneuraOu_HalfKP_noeval({ locateFile: (file) => baseUrl + file });
engine.addMessageListener((line) => { /* USI の 1 行 */ });
engine.FS.writeFile('/nn.bin', new Uint8Array(buf), { canOwn: true });
engine.postMessage('usi');
// setoption name EvalDir value . / EvalFile value nn.bin / FV_SCALE value 16
// / Threads value <n> / USI_Hash value 64 / BookFile value no_book → isready
```

node で実際に動かす例は [`test/usi-runner.cjs`](./test/usi-runner.cjs)。

## 落とし穴

- **ビルド対象は `halfkp.noeval`。** 評価関数を埋め込む `halfkp` 対象は `FV_SCALE` を 24 で焼き込み、
  `setoption` で変えられない。`halfkp.noeval` は既定が 16 で、手元 worker と同じ尺度になる
  （統合テストが `usi` の応答の `default 16` を確かめる）。
- **rootless の Docker では `-u $(id -u):$(id -g)` を付けない**（付けると EACCES で落ちる）。`build.sh` は rootless かどうかを見て切り替える。
- **エンジン本体をバンドラ（Vite）に通さない。** グルーはグローバルの名前（`exportName`）と、隣にある
  `.worker.js` / `.wasm` の名前に依存する。静的ファイルとして置く。
- **Worker の中で読み込むときは `mainScriptUrlOrBlob` にグルーの URL を渡す。** 渡さないと pthread の worker が
  エンジン本体を読めない。`.worker.js` と `.wasm` の場所は `locateFile` で決める。
- **コマンドは呼び出したスレッドで同期に実行される。** `isready` は評価関数を読み終えるまで塞ぐので、
  ブラウザではメインスレッドに置かない（統合テストが子プロセスに分けているのも同じ理由）。
- **起動時に pthread の worker を 32 本作る。** node では明示的に終えないとプロセスが残る（`terminate()` と `process.exit`）。
- **`isready` のたびに仮想 FS の `engine_options.txt` と `<EvalDir>/eval_options.txt` を読む。** そこで上書きされた
  オプションは固定され、`setoption` が効かなくなる。評価関数のディレクトリには `nn.bin` だけを置く。
- **このパッケージの `package.json` に `"type": "module"` を付けない。** グルーは CommonJS で、`dist/` の `.js` が
  ESM として読まれると node で動かなくなる（vitest の設定が `.mts` なのはこのため）。
- **Emscripten のイメージはタグで固定している**（ダイジェストではない）。実際にできた物は `manifest.json` の
  sha256 と `buildId` で識別する。
