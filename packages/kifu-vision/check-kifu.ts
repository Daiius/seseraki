// 書き出した棋譜（JSON）を初期局面から通しで再生して確かめる。
//
// `extract-simple.ts` は走査の最後に同じ検査を掛けるが、こちらは**既に
// 書き出したファイル**に後から掛けられる。走査は 10 分以上かかるので、
// 過去の出力を測り直すのに要る。
//
//   pnpm --filter kifu-vision exec tsx check-kifu.ts <棋譜 json> ...
import { readFileSync } from 'node:fs';
import { replayGame, describeProblem, type ReplayMove } from './src/replay.ts';

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error('使い方: tsx check-kifu.ts <棋譜 json> ...');
  process.exit(1);
}

for (const path of paths) {
  const data = JSON.parse(readFileSync(path, 'utf8'));
  // 初期局面から繋がるのは最初の断片だけ。途中から始まる断片は起点が分からない。
  const runs = [...data.runs].sort((a, b) => a.startedAt - b.startedAt);
  const first = runs[0];
  if (!first) continue;
  const moves: ReplayMove[] = first.moves.map((m: ReplayMove) => ({ usi: m.usi, side: m.side, time: m.time }));
  const r = replayGame(moves);
  console.log(`\n== ${data.game} 局目  ${path.split('/').pop()}`);
  console.log(`   初期局面から通しで再生: 合法 ${r.legal} / ${r.total}`);
  for (const p of r.problems) console.log(`   ${describeProblem(p)}`);
  if (r.problems.length === 0) console.log('   ✅ 問題なし');
  if (runs.length > 1) console.log(`   （${runs.length - 1} 本の断片は初期局面から繋がらないので再生していない）`);
}
