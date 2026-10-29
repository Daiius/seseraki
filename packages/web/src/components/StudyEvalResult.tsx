import type { ReactNode } from 'react';
import clsx from 'clsx';
import {
  lossLabel,
  usiToJapaneseWithPiece,
  type MateLine,
  type Side,
  type Thresholds,
} from 'shared';
import { CandidateLine } from './CandidateLine';
import { StudyEvalBrowserStatus } from './BrowserAnalysis';
import { formatTurnScore, mateLineOf, pvTexts } from '../lib/usi';
import {
  headlineCandidate,
  type EvalSource,
  type EvalState,
  type MoveGrade,
} from '../lib/positionEval';
import { useDisplaySize } from '../lib/displaySize';
import { controlButtonsOf } from '../lib/touchTargets';
import { useAnalysisAssignee } from '../lib/useMe';

/*
  検討盤の評価結果（prd/12 §3.2）。`StudyBoard` から切り出した。
  局面評価の結果・候補手と咎め筋の再生（`CandidateLine`）・直前の手の採点を描く。
  再生の状態（`Replay`）は `StudyBoard` が持つ。
*/

/**
 * 咎め筋（PV）の再生位置。**確定前のプレビュー**（prd/12 §3.2・決定 2026-09-01）。
 * ここまでの読み筋は、盤を触った時点で手順へ確定する（`commitReplay`）。
 */
export interface Replay {
  candidate: number;
  depth: number;
}

/** 手番側から数えて i 手目の手番記号 */
function symbolAt(sideToMove: Side, i: number): string {
  const sente = (i % 2 === 0) === (sideToMove === 'sente');
  return sente ? '▲' : '△';
}

/**
 * 評価結果の表示。
 *
 * ⚠ **スコアは手番側から見た値**（prd/12 §2.3）。棋譜側の `formatScore` は手数の parity で
 * 先手視点へ直すので使えない（検討局面は手数を持たない）。`formatTurnScore` を使う。
 * ⚠ **`source` を必ず出す**（prd/12 §2.6。既存解析の値とエンジンの値を黙って混ぜない）。
 */
export function EvalResultView({
  evalState,
  replay,
  onReplay,
  thresholds,
}: {
  evalState: EvalState;
  replay: Replay | null;
  onReplay: (replay: Replay | null) => void;
  thresholds: Thresholds;
}) {
  // 読み筋の再生ボタンも棋譜の操作行と同じ設定で小さくなる（`lib/touchTargets.ts`）
  // ⚠ **早期 return より前に呼ぶ**（フックの規則）
  const btn = controlButtonsOf(useDisplaySize().displaySize.controlSize);
  const inBrowser = useAnalysisAssignee() === 'browser';

  // まだ一度も評価していない（`idle`）なら何も出さない（器ごと出さない。呼び出し側と対）
  if (evalState.kind === 'idle') return null;

  /*
    🔴 **見出し「この局面の評価」は非 idle の全状態に出す**（決定・2026-09-01）。
    「評価する」がコントローラー行の常設ボタンになり、棋譜側の候補手一覧
    （`ShogiBoard` の footer・1 手前の局面の候補手）と縦に並びうるようになったため、
    どちらが何の話かを見出しで言う。**検討中と非検討時で見え方を分けない**——状態
    （`loading` / `stale` 等）で出たり消えたりすると、遷移のたびに見出しが点滅して
    かえって雑音になる。
  */
  let body: ReactNode;

  /*
    評価した後で局面が変わった状態（`stale`）。**値は消すが、手がかりは残す。**
    結果ブロックがあった場所にそのまま出すので、上の操作パネル・コントローラー行の
    位置は動かない（prd/05 §2.1）。
  */
  if (evalState.kind === 'stale') {
    body = (
      <p className="text-base-content/60">
        盤が変わったので前の評価は消した。もう一度評価できる
      </p>
    );
  } else if (evalState.kind === 'loading' && inBrowser) {
    // このブラウザで読んでいる（ダウンロードの同意・エンジンの準備の進捗もここに出す）
    body = <StudyEvalBrowserStatus />;
  } else if (evalState.kind === 'loading') {
    body = (
      <div className="flex items-center gap-2">
        <span className="loading loading-dots loading-md" aria-label="評価しています" />
        <span className="text-base-content/60">
          評価しています（エンジンが空くまで十数秒かかることがある）
        </span>
      </div>
    );
  } else if (evalState.kind === 'invalid') {
    body = (
      <div className="alert alert-warning">
        <div>
          <div className="font-semibold">この局面はエンジンに渡せない</div>
          <ul className="list-disc ps-5">
            {evalState.violations.map((v) => (
              <li key={`${v.code}-${v.message}`}>{v.message}</li>
            ))}
          </ul>
        </div>
      </div>
    );
  } else if (evalState.kind === 'busy') {
    body = (
      <div className="alert alert-warning">
        評価キューが一杯。worker が動いていない可能性がある
      </div>
    );
  } else if (evalState.kind === 'error') {
    body = <div className="alert alert-warning">{evalState.message}</div>;
  } else {
    const { base, candidates, source, grade } = evalState;
    const side = base.sideToMove;
    // 🔴 **この局面の評価値を 1 つ、単独で出す。**
    //    候補手リストの 1 行目に埋もれていると「評価値が 1 つ決まるはずなのに無い」と
    //    読めてしまう（実機で踏んだ）。棋譜閲覧の情報行（prd/05 §2.1）と同じく、
    //    見る場所を 1 か所に決める
    const headline = headlineCandidate(candidates);
    /*
      `score mate N` は plies（受方の応手・逆王手・合駒込み）なので、そのまま「N手詰」と
      書かない。読み筋を辿って形が判ったときだけ名乗る（`classifyMateLine`）。
      🔒 **直前の手の採点にも同じ分類を渡す**——採点の「指した手の評価値」は
      この評価値の符号反転そのものなので、攻方も読み筋も同じ（視点だけが逆）。
    */
    const headlineLine = headline
      ? mateLineOf(base, headline.scoreType, headline.scoreValue, headline.pv)
      : undefined;

    body = (
      <>
      {/*
        🔴 **評価値と出所を 1 行にまとめる**（決定 2026-08-29）。以前は「局面評価 [エンジン]」と
        「この局面の評価値 +42 (先手有利)」の 2 段だったが、ボタンが 1 つになって
        「どちらの評価か」を言う必要が無くなったので、見る場所も 1 行に畳む。
        評価値は**手番側から見た値**（prd/12 §2.3）。棋譜側の `formatScore` は手数の
        parity で先手視点へ直すので使えない。
        🔒 結果ブロックの中に収めるので、上の操作パネル・コントローラー行は動かない。
      */}
      <div className="flex items-baseline gap-2 flex-wrap">
        {headline && (
          <span className="text-lg font-bold">
            {formatTurnScore(headline.scoreType, headline.scoreValue, side, headlineLine)}
          </span>
        )}
        {/* 🔒 どこから来た値かを出す（prd/12 §2.6） */}
        <SourceBadge source={source} />
      </div>
      {grade && (
        <MoveGradeView grade={grade} playedLine={headlineLine} thresholds={thresholds} />
      )}
      {candidates.length === 0 && (
        <p className="text-base-content/60">候補手が返らなかった（詰みなど）</p>
      )}
      {/*
        候補手 1 本。🔴 **棋譜側の候補手一覧（`ShogiBoard` の `CandidateList`）と同じ形に畳む**
        （prd/12 §3.2・決定 2026-08-29。ユーザ要望「通常の解析画面の候補手表示の様に」）。
        独自の見せ方を作らず、**同じ `details` + `summary`** に揃える:

        - **md 未満は畳む**（既定は閉じる）。`summary` の右端に `PV{n} ▼` の手がかりを出す
        - **md 以上は常時展開**（`app.css` の `details[name='study-candidates']` の規則。
          棋譜側の `candidates` と同じ 1 か所にまとめてある）
        - `name` を持たせて**排他アコーディオン**にする（1 本開くと他が閉じる）。
          棋譜側とは別の名前にして、開閉の単位を混ぜない

        ⚠ **咎め筋の再生（確定前のプレビュー。§3.2）が畳んだ中に入る。**
        閉じたまま再生中だと、**どこまで進めたのかを操作できなくなる**。そこで
        **`details` が閉じたら再生を解除する**（`onToggle`。＝**確定せずにやめる**）。
        排他アコーディオンで他の候補を開いたときも同じ経路で解除される。
        🔒 **確定と衝突しない**——確定した時点で再生は解除され、評価結果も `stale` になって
        アコーディオンごと画面から消えるので、この規則が効くのは**まだ確定していない
        プレビューの間だけ**。「閉じたら確定済みの手まで消える」ことは起きない。
      */}
      {candidates.map((c, i) => {
        // 再生中の候補だけ非 null。**`replay?.candidate === i` だと TS が絞れない**ので
        // 絞り込んだ値そのものを持つ
        const active = replay !== null && replay.candidate === i ? replay : null;
        const pvLen = c.pv.length;
        return (
          <CandidateLine
            name="study-candidates"
            key={c.rank}
            className={clsx(active !== null && 'bg-base-200')}
            onToggle={(e) => {
              // 🔒 閉じたら再生を解除する（＝確定しない。上記のコメントの理由）。
              //    md 以上は CSS で常時展開だが、`open` 属性自体は動くので同じ経路を通る
              //    ——盤が検討局面へ戻るだけで、読めなくなるものは無い
              if (!e.currentTarget.open && active !== null) onReplay(null);
            }}
            rank={c.rank}
            moveText={`${symbolAt(side, 0)}${usiToJapaneseWithPiece(base, c.move)}`}
            scoreText={formatTurnScore(
              c.scoreType,
              c.scoreValue,
              side,
              mateLineOf(base, c.scoreType, c.scoreValue, c.pv),
            )}
            depth={c.depth}
            // 🔴 **再生位置の手を太字にする**（`CandidateLine`）。手がかりが再生カウンタ（`3/9`）だけだと、
            //    長い読み筋のどこにいるのか読み筋の側から分からない。見せ方は棋譜側と同じ
            pv={pvTexts(base, c.pv, (j) => symbolAt(side, j))}
            /*
              咎め筋の再生は**確定前のプレビュー**（prd/12 §3.2・決定 2026-09-01）。
              盤を触ればここまでが手順に確定し、「再生をやめる」なら確定せずに戻る。
              ⚠ **「戻る」から改名した**——選択肢が「捨てる / 続ける」の 2 つになった以上、
              「戻る」だけでは操作パネルの「棋譜に戻る」とどちらの戻るか読めない。
            */
            replay={{
              position: active?.depth ?? 0,
              onBack: () =>
                onReplay(
                  active !== null && active.depth > 1
                    ? { candidate: i, depth: active.depth - 1 }
                    : null,
                ),
              onForward: () => onReplay({ candidate: i, depth: (active?.depth ?? 0) + 1 }),
              backDisabled: active === null,
              forwardDisabled: active !== null && active.depth >= pvLen,
              buttonClassName: btn.touch,
              labels: { back: '読み筋を戻る', forward: '読み筋を進む' },
              extra: active !== null && (
                <button
                  type="button"
                  className={clsx(btn.touch, 'btn-ghost')}
                  onClick={() => onReplay(null)}
                  title="確定せずに検討局面へ戻る"
                >
                  再生をやめる
                </button>
              ),
            }}
          />
        );
      })}
      </>
    );
  }

  return (
    <div className="flex flex-col gap-1 text-sm">
      {/*
        見出し「この局面の評価」（決定・2026-09-01）。棋譜側の候補手一覧
        （`ShogiBoard` の footer・1 手前の局面の候補手）と縦に並びうるので、
        どちらの局面の話かをここで言う。
      */}
      <h3 className="text-xs font-semibold uppercase tracking-wide text-base-content/50">
        この局面の評価
      </h3>
      {body}
    </div>
  );
}

/**
 * 値の出所（prd/12 §2.6）。🔒 **必ず出す**——既存解析の値と今のエンジンの値を黙って混ぜない。
 * 主の局面評価と、直前の手の採点に使った 1 手前の評価は**別々の要求**なので、
 * それぞれの行に出す（片方だけ既存解析ということが起きる）。
 */
function SourceBadge({ source }: { source: EvalSource }) {
  return (
    <span
      className={clsx('badge badge-sm', source === 'kifu' ? 'badge-ghost' : 'badge-info')}
      title={
        source === 'kifu'
          ? '既存の棋譜解析から引いた値（解析時のエンジン設定は今と違いうる）'
          : '今のエンジンが計算した値'
      }
    >
      {source === 'kifu' ? '既存解析' : 'エンジン'}
    </span>
  );
}

/**
 * 直前の手の採点（prd/12 §3.2・決定 2026-08-29）。
 *
 * 「評価する」を押したとき、直前が盤上の指し手なら 1 手前の局面も評価している。
 * その最善手と、指した手（現局面の評価の符号反転）を**同じ視点**で並べて差を見せる。
 *
 * ⚠ **視点は指した側**（`grade.from.sideToMove`）。現局面の視点（相手番）とは反転している
 * ので、上の評価値の行とは符号が逆に見える——だから**「直前の手」と明示した別ブロック**に置く。
 * ⚠ **損失の数値は両方 `cp` のときだけ**（`mate` の引き算は意味を持たない。{@link scoreLoss}）。
 */
function MoveGradeView({
  grade,
  playedLine,
  thresholds,
}: {
  grade: MoveGrade;
  /** 指した手の評価値の mate 分類（主の局面評価と同じもの。視点だけが逆） */
  playedLine: MateLine | undefined;
  thresholds: Thresholds;
}) {
  const side = grade.from.sideToMove;
  const symbol = symbolAt(side, 0);
  /*
    🔒 **色は棋譜側の悪手マーカーと同じ閾値・同じ判定**（`cpl.ts` の `lossLabel`）。
    実機で「損失 5」が警告色になり、探索誤差を咎めているように見えた——同じ画面に
    「損失」の基準が 2 つあってはいけない（決定 2026-08-29）。閾値は設定から来る（§2.5）。
  */
  const label = lossLabel(grade.loss, thresholds);
  return (
    <div className="rounded-lg bg-base-200 p-2 flex flex-col gap-1">
      {/*
        🔴 **この行に出所バッジを出さない**（決定 2026-08-29）。ここの評価値は
        **主の局面評価の符号反転**で得た値なので、出所は結果ヘッダーのバッジと同じ。
        並べると「この数字は 1 手前の評価から来た」と読めてしまい、prd/12 §2.6 の
        「値の出所を黙って混ぜない」に反する（実機で実際にそう読めた）。
      */}
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-base-content/60 whitespace-nowrap">直前の手</span>
        <span className="font-bold whitespace-nowrap">
          {symbol}
          {usiToJapaneseWithPiece(grade.from, grade.move)}
        </span>
        <span className="whitespace-nowrap">
          {formatTurnScore(grade.playedScoreType, grade.playedScoreValue, side, playedLine)}
        </span>
      </div>
      {/*
        🔒 **出所バッジはこちら**（= 1 手前の局面の評価から来た値）。主の評価とは別の要求なので、
        片方だけ既存解析ということが起きる（prd/12 §2.6）。
        ⚠ **最善手だったときも出す。** 「最善手」という結論そのものが 1 手前の評価から
        導かれているので、出所を言う相手はこの行しかない。
      */}
      {grade.isBest ? (
        /* 指した手が 1 手前の rank 1 そのもの。**損失は出さない**（数字より結論が要る） */
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="font-semibold text-success">最善手</span>
          <SourceBadge source={grade.source} />
        </div>
      ) : (
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-base-content/60 whitespace-nowrap">最善</span>
          <span className="font-bold whitespace-nowrap">
            {symbol}
            {usiToJapaneseWithPiece(grade.from, grade.best.move)}
          </span>
          <span className="whitespace-nowrap">
            {formatTurnScore(
              grade.best.scoreType,
              grade.best.scoreValue,
              side,
              mateLineOf(grade.from, grade.best.scoreType, grade.best.scoreValue, grade.best.pv),
            )}
          </span>
          <SourceBadge source={grade.source} />
          {grade.loss === null ? (
            /* 🔒 `mate` が絡むときは**両者を並べるに留める**（引き算に意味が無い） */
            <span className="text-base-content/60 whitespace-nowrap">
              （詰みが絡むので損失は出さない）
            </span>
          ) : (
            <span
              className={clsx(
                'whitespace-nowrap font-semibold',
                label === 'dubious' && 'text-warning',
                label === 'blunder' && 'text-error',
              )}
            >
              損失 {grade.loss}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
