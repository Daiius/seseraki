import { describe, expect, it, vi } from 'vitest';
import { replaceTactics, type Tx } from './tactics';

/** `tx.delete().where()` と `tx.insert().values()` の呼び出しだけを記録する薄いスタブ */
function stubTx() {
  const deleted: unknown[] = [];
  const inserted: unknown[][] = [];
  const tx = {
    delete: () => ({
      where: (cond: unknown) => {
        deleted.push(cond);
        return Promise.resolve();
      },
    }),
    insert: () => ({
      values: (rows: unknown[]) => {
        inserted.push(rows);
        return Promise.resolve();
      },
    }),
  } as unknown as Tx;
  return { tx, deleted, inserted };
}

describe('replaceTactics', () => {
  it('判定したラベルを kifuTactics の行として書く', async () => {
    const { tx, inserted } = stubTx();
    // 早石田。石田流 / 三間飛車 / 振り飛車 が立つ
    const n = await replaceTactics(tx, 42, ['7g7f', '3c3d', '7f7e', '7a6b', '2h7h']);

    expect(n).toBe(3);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toEqual(
      expect.arrayContaining([
        { kifuId: 42, side: 'sente', label: '石田流', turn: 5 },
        { kifuId: 42, side: 'sente', label: '三間飛車', turn: 5 },
        { kifuId: 42, side: 'sente', label: '振り飛車', turn: 5 },
      ]),
    );
  });

  it('**先に必ず DELETE する**（置換であって追記ではない）', async () => {
    const { tx, deleted } = stubTx();
    await replaceTactics(tx, 1, ['7g7f', '3c3d', '2h6h']);
    expect(deleted).toHaveLength(1);
  });

  it('usiMoves が null ならラベルを空に置換する（「不明」であって「以前の値」ではない）', async () => {
    const { tx, deleted, inserted } = stubTx();
    const n = await replaceTactics(tx, 1, null);

    expect(n).toBe(0);
    expect(deleted).toHaveLength(1); // 旧ラベルは消す
    expect(inserted).toHaveLength(0); // 新しくは書かない
  });

  it('指し手が空でも DELETE だけは走る', async () => {
    const { tx, deleted, inserted } = stubTx();
    expect(await replaceTactics(tx, 1, [])).toBe(0);
    expect(deleted).toHaveLength(1);
    expect(inserted).toHaveLength(0);
  });

  it('ラベルが 1 つも立たない棋譜では INSERT しない', async () => {
    const { tx, deleted, inserted } = stubTx();
    // 端歩だけなら何も成立しない（`2g2f` は飛車先なので居飛車が立ってしまう）
    const n = await replaceTactics(tx, 1, ['1g1f', '9c9d']);
    expect(n).toBe(0);
    expect(deleted).toHaveLength(1);
    expect(inserted).toHaveLength(0);
  });
});
