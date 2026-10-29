import { useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { parseSfen, type HandPieceKind, type SquareRef } from 'shared';
import { client } from '../lib/honoClient';
import { callApi } from '../lib/callApi';
import { BoardWithHands, handSidesOf, pickerOf } from './BoardGrid';
import {
  applyStudyMoves,
  cancelPromotion,
  choosePromotion,
  currentState,
  isChoosingPromotion,
  lastMove,
  resolvePromotion,
  selectionDestinations,
  tapHand,
  tapSquare,
  type StudySession,
} from '../lib/study';
import { useDrillScoring } from '../lib/drillScoring';
import { BrowserAnalysisNotice, DrillEngineConsent } from './BrowserAnalysis';
import {
  lineAfterUndoTurn,
  missText,
  movesText,
  retriesAfterEngineReady,
  type MissReason,
} from '../lib/drillAnswer';
import {
  refParam,
  requestAnswer,
  requestGiveUp,
  type Drill,
  type Reveal,
  type SolveData,
} from '../lib/drillApi';
import { useBrowserAnalysisState, type BrowserAnalysisPhase } from '../lib/browserAnalysis/store';
import { requestDrillEngine } from '../lib/browserAnalysis/drillEngine';
import { useAnalysisAssignee } from '../lib/useMe';
import { listSearch, modeSearch, type DrillsSearch } from '../lib/drillSearch';
import { drillRound } from '../lib/drillRound';
import { RoundBar } from './DrillRoundBar';
import { Result, type Shown } from './DrillResult';

/*
  出題の解く画面（prd/13 §7.1・§7.6）。`routes/drills.tsx` から切り出した。
  盤の操作（`lib/study.ts` の「ルールどおり」のモード）と、判定の結果に応じた盤・表示の進め方を持つ。
  解答の通信は `lib/drillApi.ts`、解答後の表示は `DrillResult.tsx`。
*/


/** 詰将棋で間違えた手の案内（その手は盤から取り消してある） */
interface Miss {
  reason: MissReason;
  /** 咎め筋（受けの手）。日本語にして持つ（読む局面は取り消す前の盤） */
  refutationText: string | null;
}

export function DrillRunner({ initial, search }: { initial: SolveData; search: DrillsSearch }) {
  const { scoring } = useDrillScoring();
  const assignee = useAnalysisAssignee();
  const enginePhase = useBrowserAnalysisState().phase;
  const engineLoading = enginePhase === 'loading';
  const navigate = useNavigate({ from: '/drills' });
  /** 入ってきた入口。一覧から名指しで開いた問題は null（大きいボタンが「一覧に戻る」になる。prd/13 §7.6） */
  const mode = search.mode ?? null;

  // 読み込むたびに `key` で作り直す（呼び出し側）ので、ここで差し替えることはない（state に持たない）
  const drill: Drill | null = initial.drill;
  const [error, setError] = useState<string | null>(initial.error);
  /** 出題局面からの確定した手順（受方の応手を含む。prd/13 §5.3） */
  const [line, setLine] = useState<string[]>([]);
  const [session, setSession] = useState<StudySession | null>(() => sessionOf(initial.drill, []));
  const [reveal, setReveal] = useState<Shown | null>(null);
  const [judging, setJudging] = useState(false);
  /** 詰将棋で間違えた手の案内（次の操作で消える） */
  const [miss, setMiss] = useState<Miss | null>(null);
  /**
   * この問題で記録した判定（prd/13 §6.2）。🔒 **記録は 1 問 1 回**——最初に間違えた・答えを見た・解き終えた時点で
   * 決まり、以後の操作（続けて詰ませる・1 手戻す・最初から・解答後のやり直し）は練習（`practice`）で送る
   */
  const [recorded, setRecorded] = useState<Reveal['verdict'] | null>(null);
  /** 「答えを見る」の 1 段目を押した（画面内の 2 段の確認。`confirm()` は使わない） */
  const [confirmGiveUp, setConfirmGiveUp] = useState(false);
  /**
   * この端末のエンジンで採点できなかった（同意の前・解析できない環境など）ときの、エンジンの状態。案内（同意のボタンなど）も並べて出す。
   * 答えた手は盤に残し、エンジンが使えるようになったら同じ手で判定し直す（prd/13 §7.1・2026-10-29）
   */
  const [ungradableAt, setUngradableAt] = useState<BrowserAnalysisPhase | null>(null);

  /**
   * この画面の通信・判定の取り下げ。🔴 **画面を離れたら（ホーム・戻る・元の対局・次の問題）進行中の判定を打ち切る**——
   * 判定はポーリングやこのブラウザでの読みを含んで最長 240 秒ほど走る。離れた後に古い応答が届くと、ホームの loader が
   * 終えた「この回」を `drillRound.record` が 1 問だけの回として作り直す（保守性レビュー）。
   * ⚠ 作るのは effect の中（StrictMode の dev は mount → 後片付け → mount と回るので、初期値で作ると 2 回目が中断済みになる）
   */
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    return () => controller.abort();
  }, []);
  /** 今の取り下げの合図。操作は mount の後にしか起きないので、effect が作った後に読む */
  function screenSignal(): AbortSignal {
    return abortRef.current!.signal;
  }

  /**
   * 解いた後の大きいボタン。🔒 **次の問題も loader に選ばせる**（prd/13 §7.8）——問題の指定を落として replace で
   * 移ると、loader が入口の次の 1 問を選んで URL に載せ直す（履歴は積まない）。**取得は loader が持つ**
   */
  function onNext() {
    if (mode) navigate({ search: modeSearch(mode), replace: true });
    else navigate({ search: listSearch(search) });
  }

  /** 記録した解答を「この回」に数える（記録は 1 問 1 回。練習は数えない。prd/13 §7.6） */
  function noteRecorded(verdict: Reveal['verdict']) {
    setRecorded(verdict);
    drillRound.record(verdict);
  }

  const base = drill ? parseSfen(drill.sfen) : null;
  const state = session ? currentState(session) : base;
  // ⚠ **解いている側を下に置く**（自分の手番の局面しか出題されない。prd/13 §4.1）
  const flipped = base?.sideToMove === 'gote';
  const bottomSide = handSidesOf(flipped).bottom;
  /**
   * 確定前の 1 手（盤で動かしたが、まだ判定が済んでいない手）。判定中・成 / 不成を選んでいる間と、
   * エンジンの準備を待つ間（`ungradableAt`）にだけある
   */
  const pending = session && session.steps.length > line.length + 1 ? lastMove(session) : null;
  /**
   * 任意成りの手を指して、盤の上で成 / 不成を選んでいる（prd/13 §7.1・2026-10-29）。
   * 選択待ちはセッションが持つ（`lib/study.ts` の `resolvePromotion`。検討盤と同じ口）
   */
  const choosing = session !== null && isChoosingPromotion(session);

  /**
   * 盤を叩く。🔒 **盤操作は「ルールどおり」のモード**（`lib/study.ts`）——手番側の駒だけ選べ、
   * 行き先は駒の動き方の中だけ（レビュー `OCL-1A2B07B9`。server の `validateMoveOnPosition` は
   * 駒の動き方を見ないので、塗るだけだと歩を横に動かす手がエンジンまで届く）。
   * 盤の駒を選択中に駒台を叩いても駒台へは移らず、持ち駒の選択に切り替わる（prd/13 §7.1）。
   * ⚠ 検討盤は自由編集のまま——**出題だけの規則**。
   *
   * 🔒 **指したら確定のボタンを待たずに判定する**（prd/13 §7.1・2026-10-29。旧仕様の「この手で答える」は廃止）。
   * 任意成りだけ盤の上で成 / 不成を選ばせ、成らなければいけない手は黙って成らせる（`resolvePromotion`）。
   */
  function onSquare(square: SquareRef) {
    if (!session || reveal || judging) return;
    if (choosing) return cancelChoice();
    const from = settledSession();
    played(resolvePromotion(from, tapSquare(from, square)));
  }

  function onHand(kind: HandPieceKind) {
    if (!session || reveal || judging) return;
    // 成 / 不成を選んでいる間に駒台を叩いたら、選択肢の外を叩いたのと同じく取り消す
    if (choosing) return cancelChoice();
    const from = settledSession();
    setSession(tapHand(from, currentState(from).sideToMove, kind));
  }

  /**
   * 盤を叩く前のセッション。エンジンの準備を待って盤に残っている手は、**盤を叩いたら捨てる**（指し直す。自動の判定し直しも止まる）
   */
  function settledSession(): StudySession {
    if (!pending) return session!;
    setUngradableAt(null);
    setError(null);
    return sessionOf(drill, line)!;
  }

  /** 叩いた結果（成り方は決めてある）。手が 1 つ増えていて、成 / 不成の選択待ちでなければ判定へ回す */
  function played(next: StudySession) {
    const move = next.steps.length > line.length + 1 ? lastMove(next) : null;
    if (!move || isChoosingPromotion(next)) {
      setSession(next);
      return;
    }
    submit(next);
  }

  /** 盤の上の成 / 不成を選んだ */
  function choose(promote: boolean) {
    if (!session) return;
    submit(choosePromotion(session, promote));
  }

  /** 選択肢の外を叩いた。**その手を取り消す**（指す前の局面へ。選択も解く） */
  function cancelChoice() {
    if (session) setSession(cancelPromotion(session));
  }

  /** 盤の最後の手で答える */
  function submit(next: StudySession) {
    setSession(next);
    void answer(lastMove(next)!, next);
  }

  /** 確定した手順まで盤を戻す（間違えた手・確定前の手を捨てる） */
  function resetTo(next: string[]) {
    setLine(next);
    setSession(sessionOf(drill, next));
    setMiss(null);
    setError(null);
    setUngradableAt(null);
    setConfirmGiveUp(false);
  }

  /** 最初から（出題局面へ）。解答後も押せる——以後は練習（記録しない） */
  function restart() {
    resetTo([]);
    setReveal(null);
  }

  /** 1 手戻す（詰将棋。受方の応手と自分の手の 2 手ぶん） */
  function undoTurn() {
    const next = lineAfterUndoTurn(line);
    if (next) resetTo(next);
  }

  /** 答えを見る（諦め）。記録は不正解（記録済みなら練習） */
  async function giveUp() {
    if (!drill) return;
    const practice = recorded !== null;
    setConfirmGiveUp(false);
    // 成 / 不成を選んでいる手は捨てる（確定した手順で諦める）
    cancelChoice();
    setJudging(true);
    setError(null);
    // 確定した手順だけ送る（確定前の手は捨てる）
    const step = await requestGiveUp(drill, line, practice, screenSignal());
    // 画面を離れた。状態も「この回」の記録も触らない
    if (step.kind === 'aborted') return;
    setJudging(false);
    if (step.kind !== 'done') {
      setError(step.text);
      return;
    }
    const nextRecorded = practice ? recorded : step.result.verdict;
    if (!practice) noteRecorded(step.result.verdict);
    setSession(sessionOf(drill, line));
    setMiss(null);
    setReveal({ ...step.result, practice, recorded: nextRecorded });
  }

  /** 判定に回す。`at` は答えた手を指した後のセッション（state の反映を待たずに読むので引数で受ける） */
  async function answer(move: string, at: StudySession) {
    if (!drill) return;
    // 🔒 初めて詰将棋の 1 手を指したら、判定のためのエンジンを用意する（同意の前なら同意を求める。prd/13 §5.5）
    if (drill.kind === 'mate') requestDrillEngine();
    setJudging(true);
    setError(null);
    setUngradableAt(null);
    setMiss(null);
    setConfirmGiveUp(false);
    const practice = recorded !== null;
    /** 答えた手を指した後の局面（咎め筋はここから読む） */
    const answered = currentState(at);
    const outcome = await requestAnswer(
      drill,
      { line: [...line, move], ...scoring, ...(practice ? { practice: true } : {}) },
      assignee,
      screenSignal(),
    );
    switch (outcome.kind) {
      case 'aborted':
        // 画面を離れた。状態も「この回」の記録（`noteRecorded`）も触らない
        return;
      case 'fail':
        // 判定できなかった。**その手は盤から戻す**（指し直せるように）。ただしエンジンの準備（同意・ダウンロード）を
        // 待つときだけ盤に残し、準備ができたら同じ手で判定し直す（下の effect）
        setError(outcome.text);
        if (outcome.waitEngineFrom !== null) setUngradableAt(outcome.waitEngineFrom);
        else setSession(sessionOf(drill, line));
        setJudging(false);
        return;
      case 'continue': {
        // 詰みの指し継ぎ。受方の応手まで進めて次の手を待つ（prd/13 §5.2）
        const advanced = [...line, move, outcome.reply];
        setLine(advanced);
        setSession(sessionOf(drill, advanced));
        setJudging(false);
        return;
      }
      case 'miss':
        // 詰将棋で間違えた。**その手を取り消して同じ局面で考え直す**（prd/13 §5.2）。
        // 記録は最初の間違いの 1 回（server が記録済み）。以後は練習で送る
        if (!practice) noteRecorded('wrong');
        setMiss({
          reason: outcome.reason,
          refutationText: outcome.refutation.length > 0 ? movesText(answered, outcome.refutation) : null,
        });
        setSession(sessionOf(drill, line));
        setJudging(false);
        return;
      case 'done': {
        const nextRecorded = practice ? recorded : outcome.result.verdict;
        if (!practice) noteRecorded(outcome.result.verdict);
        setReveal({ ...outcome.result, practice, recorded: nextRecorded });
        setJudging(false);
        return;
      }
    }
  }

  // エンジンの同意・ダウンロード・やり直しが済んだら、盤に残した手で判定し直す（prd/13 §7.1・2026-10-29）
  useEffect(() => {
    if (ungradableAt === null || !pending || !session || judging) return;
    if (!retriesAfterEngineReady(ungradableAt, enginePhase)) return;
    void answer(pending, session);
  }, [ungradableAt, enginePhase, pending, session, judging]);

  /**
   * 自明だった（除外）。🔴 **応答を確かめてから次へ移る**（一覧の「除外を取り消す」と同じ形）——失敗を黙って飲んで
   * 次の問題へ進むと、除外できていないのに除外したと読める。失敗したらその場に留まってエラーを出す
   */
  async function exclude() {
    if (!drill) return;
    const signal = screenSignal();
    setError(null);
    const result = await callApi(
      client.api.drills[':kifuNo'][':moveNumber'][':kind'].exclude.$post({ param: refParam(drill) }),
      { fallback: (status) => `自明だった問題として記録できませんでした (${status})` },
    );
    // 待っている間に画面を離れた。離れた先から勝手に移らない
    if (signal.aborted) return;
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onNext();
  }

  if (error && !drill) {
    return (
      <>
        <RoundBar />
        <p className="text-error p-2">{error}</p>
      </>
    );
  }
  if (!drill || !state) {
    return (
      <>
        <RoundBar />
        <p className="text-base-content/70 p-2">この問題を表示できません。</p>
      </>
    );
  }

  return (
    <div className="space-y-2">
      <RoundBar
        solve={{ kifuNo: drill.kifuNo, moveNumber: drill.moveNumber, judging, onRestart: restart, onExclude: exclude }}
      />
      <div className="flex items-center gap-2 flex-wrap">
        <h1 className="text-lg font-bold">
          {drill.kind === 'mate' ? '詰ませてください' : 'ここで何を指すべきでしたか'}
        </h1>
        {drill.kind === 'mate' && drill.matePlies !== null && (
          <span className="badge badge-ghost">{drill.matePlies}手で詰み</span>
        )}
        {drill.wrongBefore && !reveal && (
          <span className="badge badge-warning badge-outline">以前間違えた</span>
        )}
      </div>

      <BoardWithHands
        state={state}
        flipped={flipped}
        selection={session?.selection}
        onSquareClick={reveal ? undefined : onSquare}
        destinations={selectionDestinations(session)}
        promotionChoice={pickerOf(session, choose, cancelChoice)}
        // 叩けるのは解いている側（下）の駒台だけ。相手の駒台は表示専用
        onHandPieceClick={(side) => (side === bottomSide && !reveal && !judging ? onHand : undefined)}
      />

      {error && <p className="text-error text-sm">{error}</p>}
      {/*
        このブラウザで読むときの案内（初回のダウンロードの進捗・同意のボタン・止まったときのやり直し）。
        サーバーで解析する利用者では何も出ない
      */}
      {assignee === 'browser' ? (
        (judging || ungradableAt !== null) && <BrowserAnalysisNotice />
      ) : (
        // サーバーで解析する利用者: 詰将棋の判定のための同意と、エンジンの準備の進捗だけ（解析の案内は出さない）
        <>
          <DrillEngineConsent />
          {judging && engineLoading && <BrowserAnalysisNotice />}
        </>
      )}

      {judging && (
        <p className="text-sm text-base-content/70">
          <span className="loading loading-spinner loading-xs align-middle mr-1" />
          判定しています
        </p>
      )}

      {miss && !reveal && !judging && (
        <div className="alert alert-warning py-2 text-sm flex flex-col items-start gap-1">
          <span>{missText(miss.reason)}。その手を取り消しました</span>
          {miss.refutationText && <span className="break-all">咎め筋 {miss.refutationText}</span>}
        </div>
      )}

      {!reveal && !judging && (
        // 盤から離して控えめに置く（prd/13 §7.1）
        <div className="flex items-center gap-2 flex-wrap pt-2 border-t border-base-300">
          {drill.kind === 'mate' && (
            <>
              <button
                type="button"
                className="btn btn-xs btn-ghost"
                disabled={lineAfterUndoTurn(line) === null}
                onClick={undoTurn}
              >
                1 手戻す
              </button>
              <button
                type="button"
                className="btn btn-xs btn-ghost"
                disabled={line.length === 0 && !pending}
                onClick={restart}
              >
                最初から
              </button>
            </>
          )}
          {!confirmGiveUp && (
            <button
              type="button"
              className="btn btn-xs btn-ghost ms-auto"
              onClick={() => setConfirmGiveUp(true)}
            >
              答えを見る
            </button>
          )}
          {confirmGiveUp && (
            // 確認の 2 ボタンだけを 1 行に並べる（スマホ幅で「やめる」が次の行に落ちないように）
            <div className="flex items-center gap-2 flex-nowrap w-full justify-end">
              <button type="button" className="btn btn-xs btn-outline btn-error" onClick={giveUp}>
                本当に答えを見る（不正解になります）
              </button>
              <button type="button" className="btn btn-xs btn-ghost" onClick={() => setConfirmGiveUp(false)}>
                やめる
              </button>
            </div>
          )}
        </div>
      )}

      {reveal && (
        <Result
          reveal={reveal}
          drill={drill}
          base={base!}
          // 咎め筋は**答えた手を指した後**の局面から読む（相手の応手から始まるため）
          answered={state}
          mode={mode}
          onNext={onNext}
        />
      )}
    </div>
  );
}

/** 出題局面 + 確定した手順からセッションを作る */
function sessionOf(drill: Drill | null, line: string[]): StudySession | null {
  if (!drill) return null;
  const base = parseSfen(drill.sfen);
  // 🔒 出題の盤は「ルールどおり」（`lib/study.ts`。prd/13 §7.1）
  return base ? applyStudyMoves(base, line, 'rules') : null;
}
