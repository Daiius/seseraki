import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { usiToJapaneseWithPiece, type BoardState } from 'shared';
import { client } from '../lib/honoClient';
import { callApi } from '../lib/callApi';
import { refParam, type Drill, type Reveal } from '../lib/drillApi';
import { matePliesText, movesText, practiceNote, resultBadge } from '../lib/drillAnswer';
import { MODE_LABEL, modeSearch, type DrillMode } from '../lib/drillSearch';
import { DrillAttemptHistory, type DrillAttemptRow } from './DrillCards';
import { ChevronDownIcon, DrillModeIcon } from './icons';

/** 解答後の表示に要る、画面側の事情（練習で解いたか・記録済みの判定） */
export interface Shown extends Reveal {
  practice: boolean;
  recorded: Reveal['verdict'] | null;
}

/** 解答後の表示。**ここで初めて棋譜・手数・正解が出る**（prd/13 §7） */
export function Result({
  reveal,
  drill,
  base,
  answered,
  mode,
  onNext,
}: {
  reveal: Shown;
  drill: Drill;
  base: BoardState;
  /** 答えた手を指した後の局面（咎め筋の読み出しに使う） */
  answered: BoardState;
  /** 入ってきた入口（一覧から開いた問題は null） */
  mode: DrillMode | null;
  /** 大きいボタン（入口の次の問題 / 一覧に戻る） */
  onNext: () => void;
}) {
  const verdict = resultBadge(drill.kind, reveal.verdict, reveal.practice);
  const note = practiceNote(reveal.practice, reveal.recorded);
  // 大きいボタンは「次の問題」＋今の入口のアイコン（読み上げは aria-label で入口名まで）
  const nextLabel = mode ? (
    <>
      次の問題
      <DrillModeIcon mode={mode} />
    </>
  ) : (
    '一覧に戻る'
  );
  const otherModes = (['recommend', 'mate', 'best', 'wrong'] as const).filter((other) => other !== mode);
  return (
    <div className="card bg-base-200 p-3 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`badge ${verdict.className}`}>{verdict.label}</span>
        {reveal.lossCp !== null && (
          <span className="text-sm">損失 {reveal.lossCp}cp</span>
        )}
        {drill.kind === 'mate' && reveal.verdict === 'correct' && (
          <span className="text-sm">{matePliesText(reveal.plies, reveal.answerPlies)}</span>
        )}
        {reveal.gaveUp && <span className="text-sm text-base-content/70">答えを見ました</span>}
        <span className="text-sm">
          正解 {usiToJapaneseWithPiece(base, reveal.answerMove)}
        </span>
      </div>
      {note && <p className="text-xs text-base-content/60">{note}</p>}

      {drill.kind === 'mate' && reveal.answerPv && (
        <p className="text-sm break-all">
          詰み手順 {movesText(base, reveal.answerPv)}
        </p>
      )}
      {reveal.refutation && reveal.refutation.length > 0 && (
        <p className="text-sm break-all">
          咎め筋 {movesText(answered, reveal.refutation)}
        </p>
      )}
      {reveal.playedMove && (
        <p className="text-sm">
          実戦は {usiToJapaneseWithPiece(base, reveal.playedMove)}
          {reveal.playedLossCp !== null && `（損失 ${reveal.playedLossCp}cp）`}
        </p>
      )}

      {/*
        解いた後のボタン（prd/13 §7.6）。入口の続き（大）と、ほかの入口へのドロップダウンを join で 1 本につなぐ。
        元の対局・やり直す・自明だったは上の行のケバブ（`SolveMenu`）
      */}
      <div className="join w-full">
        <button
          type="button"
          className="btn btn-primary join-item flex-1 px-2"
          onClick={onNext}
          aria-label={mode ? `次の問題（${MODE_LABEL[mode]}）` : undefined}
        >
          {nextLabel}
        </button>
        <div className="dropdown dropdown-end join-item">
          <div
            tabIndex={0}
            role="button"
            className="btn btn-primary join-item w-16 px-0 border-0 border-l border-l-primary-content/40"
            aria-label="ほかの入口"
          >
            <ChevronDownIcon className="size-5" />
          </div>
          <ul tabIndex={0} className="dropdown-content menu bg-base-100 rounded-box z-10 mt-1 w-44 p-2 shadow">
            {/* 今の入口と同じになるものは出さない */}
            {otherModes.map((other) => (
              <li key={other}>
                <Link to="/drills" search={modeSearch(other)} replace className="text-base">
                  <DrillModeIcon mode={other} />
                  {MODE_LABEL[other]}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <AttemptsOf drill={drill} />
    </div>
  );
}

/**
 * この問題の解答履歴（prd/13 §7.7）。🔒 **解いた後にだけ出す**（`Result` の中だけで使う）——
 * 正解の記録の「指した手」は答えそのもの。解いた直後の記録も入るよう、解答後の表示が出るたびに引く
 */
function AttemptsOf({ drill }: { drill: Drill }) {
  const [rows, setRows] = useState<DrillAttemptRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { kifuNo, moveNumber, kind } = drill;
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await callApi(
        client.api.drills[':kifuNo'][':moveNumber'][':kind'].attempts.$get({
          param: refParam({ kifuNo, moveNumber, kind }),
        }),
      );
      if (cancelled) return;
      // 失敗の理由は出さない（履歴は添え物。読めなかったことだけ伝える）
      if (result.ok) setRows(result.data.attempts);
      else setError('解答履歴を読み込めませんでした');
    })();
    return () => {
      cancelled = true;
    };
  }, [kifuNo, moveNumber, kind]);
  return (
    <details className="pt-2 border-t border-base-300">
      <summary className="text-sm cursor-pointer">この問題の解答履歴</summary>
      <div className="pt-1">
        {error && <p className="text-error text-sm">{error}</p>}
        {rows && <DrillAttemptHistory rows={rows} />}
        {!rows && !error && <span className="loading loading-spinner loading-xs" />}
      </div>
    </details>
  );
}
