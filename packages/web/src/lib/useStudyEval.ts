import { useEffect, useRef, useState } from 'react';
import {
  EvalRequestTracker,
  evalStateAfterPositionChange,
  gradeLastMove,
  headlineCandidate,
  requestPositionEval,
  validateEvalTarget,
  type EvalState,
} from './positionEval';
import { lastMoveGradeTarget, positionEvalTarget, type StudySession } from './study';
import { useAnalysisAssignee } from './useMe';
import { requestBrowserStudyEval } from './browserAnalysis/studyEval';

/**
 * 検討盤の「評価する」の要求と結果（prd/12 §3.2）。`StudyBoard` から切り出した。
 *
 * 結果（`evalState`）と、走っている要求の番人（`EvalRequestTracker`）をここで持つ。
 * 盤の状態（検討セッション・咎め筋の再生）は `StudyBoard` が持ち、評価する局面は `run` に渡す。
 */
export function useStudyEval(initialEval?: EvalState) {
  const [evalState, setEvalState] = useState<EvalState>(initialEval ?? { kind: 'idle' });
  /**
   * 走っている評価要求の番人（`EvalRequestTracker`）。
   * 🔒 **局面が変わりうる操作のたびに `cancel()` を呼ぶ**——さもないと旧局面の応答が
   * 今の盤の評価として出る（レビュー指摘 `OCL-AED22F46`）。
   */
  const trackerRef = useRef(new EvalRequestTracker());
  /**
   * 「ブラウザで解析」の利用者は、局面評価をこのブラウザのエンジンで読む（prd/12 §2.4・2026-10-29）。
   * server の評価の口は手元 worker にジョブを積むので、この利用者には 403 を返す
   */
  const inBrowser = useAnalysisAssignee() === 'browser';

  // アンマウントでも走っている評価要求（ポーリング）を捨てる（起点の変化は `reset` で処理する）
  useEffect(() => () => trackerRef.current.cancel(), []);

  /**
   * 起点が変わった（棋譜側が手送りされた）。結果を消し、走っている要求もこの場で捨てる。
   * ⚠ `StudyBoard` がレンダー中に呼ぶ（「props が変わったら state を作り直す」定石）。何度呼んでも安全
   */
  const reset = () => {
    setEvalState({ kind: 'idle' });
    trackerRef.current.cancel();
  };

  /**
   * 検討中の編集で局面が変わった。走っている要求を捨てる。
   * 🔴 **黙って消さない。** 一度でも評価に触れていれば `stale` にして
   * 「盤が変わった / もう一度評価できる」ことを言う（実機で「もう評価
   * できないのか」と読めてしまった。値そのものは残さない）
   */
  const positionChanged = () => {
    trackerRef.current.cancel();
    setEvalState(evalStateAfterPositionChange(evalState));
  };

  /**
   * 「評価する」（prd/12 §3.2・決定 2026-08-29）。**ボタンは 1 つ**。
   *
   * 主は**現在の検討局面の局面評価**。加えて**直前が盤上の指し手なら 1 手前の局面も
   * 並行して評価**し、直前の手の採点（最善との差 = 損失）を出す。
   *
   * 🔒 **副次の要求が主を壊さないこと。** 1 手前の評価が失敗・busy・abort でも、
   * 主の局面評価の結果は必ず出す（採点だけ省く）。`requestPositionEval` は例外を
   * 投げないので、`Promise.all` でまとめても主が落ちることはない。
   *
   * 🔒 **世代（token）は 1 つ、`AbortSignal` は共有**（レビュー指摘 `OCL-AED22F46`）。
   * `begin()` を 2 回呼ぶと 1 本目が自分自身の 2 本目に捨てられ、判定が崩れる。
   */
  const run = async (shown: StudySession) => {
    const gradeTarget = lastMoveGradeTarget(shown);
    const target = positionEvalTarget(shown);
    // 🔴 **基点は送り先と同じ関数から取る**（レビュー指摘 `OCL-753E7A28`）。
    //    ここで別に数え直すと、undo して redo 分が残っているときに
    //    「送った局面」と「検証・PV 再生の基点」がずれる。
    const from = target.from;

    // 🔒 **送る前にクライアントで検証する**（往復を減らす。判定は `shared` の 1 つ）
    const violations = validateEvalTarget(from, target.move);
    if (violations.length > 0) {
      // 🔴 **走っている要求もここで捨てる。** 弾いた新局面の警告を、後から届いた
      //    旧局面の結果が上書きしてしまう（レビュー指摘 `OCL-AED22F46`）
      trackerRef.current.cancel();
      setEvalState({ kind: 'invalid', violations });
      return;
    }

    // 押し直したら前の要求を捨てる（二重送信の抑止も兼ねる）
    const { token, signal } = trackerRef.current.begin();
    setEvalState({ kind: 'loading' });

    // 採点用の副次要求。⚠ **弾かれたら黙って採点だけ諦める**（主の警告にはしない）
    const grading =
      gradeTarget !== null
      && validateEvalTarget(gradeTarget.target.from, null).length === 0
        ? gradeTarget
        : null;

    // 🔴 **2 本は同時に投げるが、待ち方は分ける**（レビュー指摘 `OCL-BE4CEA52`）。
    //    `Promise.all` で揃えて待つと、**主が返っていても副次が返るまで画面が `loading` のまま**に
    //    なる。副次はキュー待ち・長い探索で主より大きく遅れうるので、
    //    「副次が失敗・busy・中断でも主は必ず出す」という要求を満たせない（永久に出ない場合すらある）。
    //    → **主が返った時点で表示し、採点は後から追記する。**
    //
    // 🔴 **発行の順は「主 → 副次」**（レビュー指摘 `OCL-17AFF653`）。`requestPositionEval` は
    //    最初の await まで同期に走る＝**呼んだ順に POST が出る**ので、副次を先に呼ぶと
    //    **server の評価キュー（有限）の最後の 1 枠を副次が取り、主が 503 になる**。
    //    「採点は進んでいるのに主は『キューが一杯』」という優先順位の逆転が起きるため、
    //    **枠の取り合いでは主を先に通す。** ⚠ 同時実行は保つ（await は下でまとめて行う）。
    //
    // 🔴 **ブラウザで読むときだけは直列にする**（2026-10-29。prd/12 §2.4）。エンジンはこのブラウザに 1 本なので、
    //    並行に頼んでも順に読むだけ——**主を読み終えてから 1 手前を読む**ことを明示する（主の結果を先に出し、
    //    採点は後から足す、という見え方は同じ）。主が出なければ 1 手前は読まない。
    //    取り下げ（局面が変わった）は同じ `signal` で、まだ読んでいない側は読まずに捨てる
    const evaluate = inBrowser ? requestBrowserStudyEval : requestPositionEval;
    const resultPromise = evaluate(target, signal);
    const gradePromise = grading
      ? inBrowser
        ? resultPromise.then((first) =>
            first.kind === 'done' ? evaluate(grading.target, signal) : first,
          )
        : evaluate(grading.target, signal)
      : null;

    const result = await resultPromise;
    // 🔒 待っている間に局面が変わっていたら**この結果は今の盤のものではない**
    if (!trackerRef.current.accepts(token)) return;
    switch (result.kind) {
      case 'aborted':
        return;
      case 'invalid':
        setEvalState({ kind: 'invalid', violations: result.violations });
        return;
      case 'busy':
        setEvalState({ kind: 'busy' });
        return;
      case 'failed':
        setEvalState({ kind: 'error', message: result.message });
        return;
      case 'done':
        break;
    }

    // 主の結果はここで出す（採点はまだ無い）
    setEvalState({
      kind: 'done',
      base: from,
      candidates: result.candidates,
      source: result.source,
      grade: null,
    });

    if (grading === null || gradePromise === null) return;
    const gradeResult = await gradePromise;
    // ⚠ 採点は**取れたときだけ**。1 手前が失敗・busy・abort なら主の結果を出したまま何もしない
    if (!trackerRef.current.accepts(token) || gradeResult.kind !== 'done') return;
    const grade = gradeLastMove({
      from: grading.target.from,
      move: grading.move,
      current: headlineCandidate(result.candidates),
      previousCandidates: gradeResult.candidates,
      previousSource: gradeResult.source,
    });
    // 🔒 **今出ている主の結果に足すだけ**にする。`kind` を見て、待っている間に別の状態
    //    （`stale` / 新しい評価）へ移っていたら触らない——token の判定と二重の守り
    setEvalState((prev) => (prev.kind === 'done' ? { ...prev, grade } : prev));
  };

  return { evalState, run, reset, positionChanged };
}
