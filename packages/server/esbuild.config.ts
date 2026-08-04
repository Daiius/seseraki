import { build } from "esbuild";

// ⚠ **エントリは名前付きで渡す。** 配列で渡すと出力先が入力の共通ベースからの相対になり、
// src/ と直下のスクリプトが別階層にあるため dist/src/index.js に落ちる。
// 名前付き + outdir なら `server` → dist/server.js で、従来の outfile と同じパスになる
// （Dockerfile.prod の COPY を変えずに済む）。
await build({
  entryPoints: {
    server: "./src/index.ts",
    // 一括再判定。**本番イメージへ同梱し、使い捨てコンテナとして明示的に実行する**
    // （起動時の自動適用にはしない——失敗時の挙動とインスタンス増加時の競合が読めなくなる）。
    //   docker compose run --rm <service>  # command: ["/app/redetect-tactics.js"]
    // ⚠ 本番イメージは distroless（ENTRYPOINT=node）なので command はパスだけでよい。
    "redetect-tactics": "./redetect-tactics.ts",
    // マイグレーションの適用。**同梱する理由はポートを開けずに済むことではなく、
    // 適用する SQL とコードのバージョンが構造的に一致すること。**
    // ホストから流す方式は「手元にある SQL を、本番で動いているイメージへ流す」ことになり、
    // **両者がずれても何も警告されない**。同じイメージの中身ならずれが原理的に起きない。
    // 副次的に、接続先の取り違え（`:dev` が tunnel 越しに本番を指す等）も起きなくなる。
    //   docker compose run --rm <service>  # command: ["/app/migrate.js"]
    // ⚠ **生成した SQL はバンドルに入らない**（migrator が実行時に fs で読む）。
    //   `Dockerfile.prod` が `drizzle/` を別途 COPY する。
    migrate: "./migrate.ts",
  },
  outdir: "./dist",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  minify: true,
  sourcemap: false,
  banner: {
    js: `
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
`,
  },
});

console.log("Build completed successfully!");
