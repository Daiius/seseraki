import { describe, expect, it } from 'vitest';
import { DEFAULT_DISPLAY_SIZE, parseDisplaySize } from './displaySize';

describe('parseDisplaySize', () => {
  it('未保存なら既定値（＝現状の見た目）', () => {
    expect(parseDisplaySize(null)).toEqual(DEFAULT_DISPLAY_SIZE);
    expect(DEFAULT_DISPLAY_SIZE).toEqual({
      boardSize: 'full',
      controlSize: 'normal',
      graphSize: 'normal',
    });
  });

  it('保存された組み合わせを読み戻す', () => {
    expect(
      parseDisplaySize(
        '{"boardSize":"compact","controlSize":"compact","graphSize":"compact"}',
      ),
    ).toEqual({ boardSize: 'compact', controlSize: 'compact', graphSize: 'compact' });
    expect(
      parseDisplaySize(
        '{"boardSize":"compact","controlSize":"normal","graphSize":"normal"}',
      ),
    ).toEqual({ boardSize: 'compact', controlSize: 'normal', graphSize: 'normal' });
  });

  it('設定が増える前に保存された値を読んでも、既にある設定は保たれる', () => {
    // `graphSize` を足す前のブラウザに残っている形。全部リセットしてはいけない
    expect(parseDisplaySize('{"boardSize":"compact","controlSize":"compact"}')).toEqual({
      boardSize: 'compact',
      controlSize: 'compact',
      graphSize: 'normal',
    });
  });

  it('JSON として壊れている・オブジェクトでない値は既定値に落とす', () => {
    for (const raw of ['', '{', 'null', '"compact"', '3', '[]']) {
      expect(parseDisplaySize(raw)).toEqual(DEFAULT_DISPLAY_SIZE);
    }
  });

  it('壊れているのが片方だけなら、もう片方は生かす', () => {
    // 手で書き換えられた・古い版の値が残っている、といった場合を想定
    expect(
      parseDisplaySize('{"boardSize":"compact","controlSize":"huge","graphSize":"compact"}'),
    ).toEqual({ boardSize: 'compact', controlSize: 'normal', graphSize: 'compact' });
    expect(parseDisplaySize('{"controlSize":"compact"}')).toEqual({
      boardSize: 'full',
      controlSize: 'compact',
      graphSize: 'normal',
    });
  });

  it('列挙にない値は既定値に落とす（`normal` と `full` を取り違えても通さない）', () => {
    expect(
      parseDisplaySize('{"boardSize":"normal","controlSize":"full","graphSize":"half"}'),
    ).toEqual(DEFAULT_DISPLAY_SIZE);
  });
});
