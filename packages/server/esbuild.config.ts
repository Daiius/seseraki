import { spawnSync } from "node:child_process";
import { build } from "esbuild";

// ⚠ **エントリは名前付きで渡す。** 配列で渡すと出力先が入力の共通ベースからの相対になり、
// src/ と直下のスクリプトが別階層にあるため dist/src/index.js に落ちる。
// 名前付き + outdir なら `server` → dist/server.js で、従来の outfile と同じパスになる
// （Dockerfile.prod の COPY を変えずに済む）。
// 生成後の構文チェック（下）でも使うので、名前の一覧を変数に持つ。
const entryPoints = {
    server: "./src/index.ts",
    // 一括再判定。**本番イメージへ同梱し、使い捨てコンテナとして明示的に実行する**
    // （起動時の自動適用にはしない——失敗時の挙動とインスタンス増加時の競合が読めなくなる）。
    //   docker compose run --rm <service>  # command: ["/app/redetect-tactics.js"]
    // ⚠ 本番イメージは distroless（ENTRYPOINT=node）なので command はパスだけでよい。
    "redetect-tactics": "./redetect-tactics.ts",
    // 局面索引の一括再構築。**同梱しないと本番で既存棋譜が検索に出ない**——
    // マイグレーションは空の kifu_positions を作るだけで、既存棋譜の行は
    // 再構築を流すまで 1 行も入らない（新規取り込みぶんしか現れない）。
    //   docker compose run --rm <service>  # command: ["/app/rebuild-positions.js"]
    "rebuild-positions": "./rebuild-positions.ts",
    // マイグレーションの適用。**同梱する理由はポートを開けずに済むことではなく、
    // 適用する SQL とコードのバージョンが構造的に一致すること。**
    // ホストから流す方式は「手元にある SQL を、本番で動いているイメージへ流す」ことになり、
    // **両者がずれても何も警告されない**。同じイメージの中身ならずれが原理的に起きない。
    // 副次的に、接続先の取り違え（`:dev` が tunnel 越しに本番を指す等）も起きなくなる。
    //   docker compose run --rm <service>  # command: ["/app/migrate.js"]
    // ⚠ **生成した SQL はバンドルに入らない**（migrator が実行時に fs で読む）。
    //   `Dockerfile.prod` が `drizzle/` を別途 COPY する。
    migrate: "./migrate.ts",
};

await build({
  entryPoints,
  outdir: "./dist",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  minify: true,
  sourcemap: false,
  // ESM 出力に CJS の `require` / `__filename` / `__dirname` を用意する。
  // バンドルに含まれる CJS 依存（mysql2 等）が実行時にこれらを参照するため必須。
  //
  // ⚠ **import する名前は `__esbuild` 接頭辞で名前空間を切る。** banner は生成コードへ
  // **そのまま前置**され、**esbuild の記号表の外**にある。素の名前（`fileURLToPath` 等）にすると、
  // ソース側が同じ名前を import した瞬間に ESM スコープで二重宣言になり、
  // **Node が構文解析で落ちる**（`migrate.ts` が `fileURLToPath` を import して実際に踏んだ）。
  // `minify: true` の間は esbuild がソース側をリネームするので**たまたま通る**が、
  // minify を切ると即座に壊れる。名前を衝突しないものにしておけば minify に依存しない。
  // 露出させる `require` / `__filename` / `__dirname` は shim の目的そのものなので素の名前のまま。
  banner: {
    js: `
import { createRequire as __esbuildCreateRequire } from 'module';
import { fileURLToPath as __esbuildFileURLToPath } from 'url';
import { dirname as __esbuildDirname } from 'path';

const require = __esbuildCreateRequire(import.meta.url);
const __filename = __esbuildFileURLToPath(import.meta.url);
const __dirname = __esbuildDirname(__filename);
`,
  },
});

// 生成物を Node の構文解析に通す。**banner の衝突は esbuild が検出できない**ので、
// ここで落としておかないと本番の使い捨てコンテナを起動するまで気づけない。
// `node --check` は実行せずに解析だけするので、DB へ繋がる心配はない。
for (const name of Object.keys(entryPoints)) {
  const file = `./dist/${name}.js`;
  const { status, stderr } = spawnSync(process.execPath, ["--check", file], {
    encoding: "utf8",
  });
  if (status !== 0) {
    console.error(`syntax check failed: ${file}\n${stderr}`);
    process.exit(1);
  }
}

console.log("Build completed successfully!");
