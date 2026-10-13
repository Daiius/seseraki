import { describe, expect, it } from 'vitest';
import { evaluateButtonViewState } from './evaluateButton';

describe('evaluateButtonViewState', () => {
  it('棋譜再生中（検討していない）は汎用の文面で押せる', () => {
    const view = evaluateButtonViewState({ studying: false, grading: false, evaluating: false });
    expect(view).toEqual({
      disabled: false,
      busy: false,
      title: 'この局面をエンジンに評価させる',
    });
  });

  it('検討中でも直前の手が採点対象でなければ汎用の文面（棋譜側と同じ）', () => {
    const view = evaluateButtonViewState({ studying: true, grading: false, evaluating: false });
    expect(view).toEqual({
      disabled: false,
      busy: false,
      title: 'この局面をエンジンに評価させる',
    });
  });

  it('検討中で直前の手が採点対象なら採点まで出ることを言う', () => {
    const view = evaluateButtonViewState({ studying: true, grading: true, evaluating: false });
    expect(view).toEqual({
      disabled: false,
      busy: false,
      title: 'この局面を評価し、直前の手が最善とどれだけ離れていたかも出す',
    });
  });

  it('grading=true でも studying=false なら汎用の文面（棋譜側では起こらない組み合わせだが防御的に扱う）', () => {
    const view = evaluateButtonViewState({ studying: false, grading: true, evaluating: false });
    expect(view).toEqual({
      disabled: false,
      busy: false,
      title: 'この局面をエンジンに評価させる',
    });
  });

  it('評価中は studying / grading に関わらず disabled + busy + 評価中の文面', () => {
    expect(evaluateButtonViewState({ studying: false, grading: false, evaluating: true })).toEqual({
      disabled: true,
      busy: true,
      title: '評価しています',
    });
    expect(evaluateButtonViewState({ studying: true, grading: true, evaluating: true })).toEqual({
      disabled: true,
      busy: true,
      title: '評価しています',
    });
  });

  it('評価を使えない（ブラウザで解析する設定）ときは押せず、理由を title で言う', () => {
    const view = evaluateButtonViewState({
      studying: true,
      grading: true,
      evaluating: false,
      unavailable: true,
    });
    expect(view.disabled).toBe(true);
    // 評価中ではないのでスピナーにはしない
    expect(view.busy).toBe(false);
    expect(view.title).toContain('まだ使えません');
  });
});
