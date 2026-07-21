import { describe, expect, it } from 'vitest';
import { generateKifuMarkdown, type ExportAnalysis, type KifuExportInput } from './index';

/**
 * 実際に指せる 6 手を並べ、各局面に候補手を与えて段階ラベルを作り分ける。
 * - 2 手目 △３四歩: 損失 170cp → 疑問手
 * - 4 手目 △８四歩: 損失 350cp → 悪手
 * - 6 手目 △８五歩: 最善が 3 手詰 → 詰み逃し
 * - 1 / 3 / 5 手目: 最善手そのもの（損失 0）
 */
const USI_MOVES = ['7g7f', '3c3d', '2g2f', '8c8d', '2f2e', '8d8e'];

function candidate(
  rank: number,
  move: string,
  score: number,
  scoreType = 'cp',
) {
  return { rank, move, scoreType, scoreValue: score, pv: null, depth: 10 };
}

const ANALYSES: ExportAnalysis[] = [
  { moveNumber: 0, candidates: [candidate(1, '7g7f', 100), candidate(2, '2g2f', 60)] },
  { moveNumber: 1, candidates: [candidate(1, '8c8d', 50), candidate(2, '3c3d', -120)] },
  { moveNumber: 2, candidates: [candidate(1, '2g2f', 200), candidate(2, '6i7h', 150)] },
  { moveNumber: 3, candidates: [candidate(1, '4a3b', 100), candidate(2, '8c8d', -250)] },
  { moveNumber: 4, candidates: [candidate(1, '2f2e', 300), candidate(2, '3i4h', 280)] },
  { moveNumber: 5, candidates: [candidate(1, '3a2b', 3, 'mate'), candidate(2, '8d8e', -50)] },
  { moveNumber: 6, candidates: [candidate(1, '2e2d', -400)] },
];

function markdown(input: Partial<KifuExportInput> = {}): string {
  return generateKifuMarkdown({
    title: 'テスト対局',
    usiMoves: USI_MOVES,
    analyses: ANALYSES,
    ...input,
  });
}

/** `### 4 手目 …` の見出しに現れた手数 */
function notableMoveNumbers(md: string): number[] {
  return md
    .split('\n')
    .filter((l) => l.startsWith('### '))
    .map((l) => Number(l.replace('### ', '').split(' ')[0]));
}

/** 評価値推移表の指定手数の行 */
function tableRow(md: string, moveNumber: number): string | undefined {
  return md.split('\n').find((l) => l.startsWith(`| ${moveNumber} |`));
}

describe('generateKifuMarkdown', () => {
  it('疑問手は評価値推移表の備考にだけ出し、注目局面の節にはしない', () => {
    const md = markdown();

    expect(tableRow(md, 2)).toContain('?疑問手（170cp 損）');
    expect(notableMoveNumbers(md)).not.toContain(2);
  });

  it('悪手と詰み系は注目局面の節になる', () => {
    const md = markdown();

    expect(notableMoveNumbers(md)).toEqual(expect.arrayContaining([4, 6]));
    expect(tableRow(md, 4)).toContain('⚠悪手（350cp 損）');
    expect(md).toContain('### 4 手目 △８四歩(83)（悪手、損失 350cp');
    expect(md).toContain('### 6 手目 △８五歩(84)（詰み逃し（3手詰）');
  });

  it('詰みは ±M 表記のまま出す（±3000 クランプで手数を失わない）', () => {
    const md = markdown();

    // 注目局面の見出しは実手を指す前の局面の評価値から始まる（3 手詰＝後手視点なので -M3）
    expect(md).toContain('評価値 -M3 →');
    expect(md).not.toContain('評価値 -3000');
  });

  it('「好手」は出力しない', () => {
    expect(markdown()).not.toContain('好手');
  });

  it('閾値を上げると段階ラベルが消える（CPL の数値は判定に使われ続ける）', () => {
    const md = markdown({
      thresholds: { blunder: 1000, dubious: 500, decided: 1000 },
    });

    expect(tableRow(md, 2)).not.toContain('疑問手');
    expect(tableRow(md, 4)).not.toContain('悪手');
    // 詰み系は閾値と無関係に残る
    expect(notableMoveNumbers(md)).toContain(6);
  });

  it('決着した局面にはラベルを付けない', () => {
    const md = markdown({
      thresholds: { blunder: 300, dubious: 150, decided: 100 },
    });

    // 4 手目の局面の最善は +100 で決着閾値に達するため悪手にしない
    expect(tableRow(md, 4)).not.toContain('悪手');
  });
});
