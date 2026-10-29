/**
 * 出題（prd/13）: 次の 1 問・在庫・一覧・名指しの 1 問・解答履歴・除外・諦め・解答。
 *
 * 🔴 **答えを含む列は出題時に返さない**（prd/13 §7）。問題は棋譜の番号・手数・種類の組で指す（prd/14 §4.4）。
 */
import { Hono } from 'hono';
import { z } from 'zod';
import {
  applyMove,
  buildPositions,
  drillNamedEvaluationSchema,
  validateMoveOnPosition,
  type BoardState,
} from 'shared';
import { zv } from '../zod-validator.js';
import { sessionRequired } from '../auth.js';
import { analysisAssigneeOf } from '../analysis-report.js';
import {
  DEFAULT_SCORING,
  givesCheck,
  isGiveUpLine,
  isReachableMove,
  matchMateLine,
  scoreFromCandidates,
  type DrillScoring,
} from '../drill-answer.js';
import { forgetLine, recallLine } from '../drill-lines.js';
import { resolveWithEngine, type ResolveInput } from '../drill-engine.js';
import {
  drillCounts,
  listDrillAttemptsOf,
  listDrills,
  loadDrill,
  loadDrillQuestion,
  pickNextDrill,
  recordAttempt,
  unexcludeDrill,
} from '../drill-query.js';
import { drillListQuerySchema, drillNextQuerySchema } from '../drill-list-query.js';
import { drillRefParam, smallBody } from './common.js';

/** 出題局面（`moveNumber` 手を指す直前の局面）。指し手列が足りなければ null */
function drillPosition(usiMoves: string[] | null, moveNumber: number): BoardState | null {
  if (!usiMoves || moveNumber > usiMoves.length) return null;
  return buildPositions(usiMoves)[moveNumber] ?? null;
}

/** 出題局面に手順を積む。読めない手が混ざったら null（数字を捏造しない） */
function applyLine(base: BoardState, moves: string[]): BoardState | null {
  let state = base;
  for (const move of moves) {
    try {
      state = applyMove(state, move);
    } catch {
      return null;
    }
  }
  return state;
}

/**
 * 解答後にだけ返す情報（ネタバレ回避。prd/13 §7）。棋譜は番号で返す（prd/14 §4.4）。
 * `plies` はユーザーの手順の手数、`answerPlies` は当初の正解手順の手数（詰将棋の結果に出す。prd/13 §7.1）
 */
function drillReveal(
  drill: NonNullable<Awaited<ReturnType<typeof loadDrill>>>,
  line: string[],
) {
  return {
    kifuNo: drill.kifuNo,
    moveNumber: drill.moveNumber,
    reason: drill.reason,
    answerMove: drill.answerMove,
    answerPv: drill.answerPv,
    playedMove: drill.playedMove,
    playedLossCp: drill.playedLossCp,
    plies: line.length,
    answerPlies: drill.answerPv?.length ?? null,
  };
}

/**
 * エンジンの採点結果を HTTP へ写す。**待ちは 202、キュー満杯は 503**（prd/12 §2.4 と同じ流儀）。
 * ブラウザに読ませる（`evaluate`。担当 `browser`）は 200——ブラウザが読んで同じ解答を送り直す
 */
async function answerWithEngine(input: ResolveInput, reveal: Record<string, unknown>) {
  const answer = await resolveWithEngine(input);
  switch (answer.status) {
    case 'pending':
      return { body: { status: 'pending' as const, jobId: answer.jobId }, status: 202 as const };
    case 'busy':
      return { body: { error: '評価キューが一杯です' }, status: 503 as const };
    case 'failed':
      return { body: { error: answer.error }, status: 502 as const };
    case 'evaluate':
      // 🔒 **答えは載せない**（`reveal` を付けない）。局面・利用者の手・読む設定だけ
      return {
        body: { status: 'evaluate' as const, sfen: answer.sfen, move: answer.move, settings: answer.settings },
        status: 200 as const,
      };
    case 'continue':
      return { body: { status: 'continue' as const, reply: answer.reply }, status: 200 as const };
    case 'miss':
      // 🔒 **答えは載せない**（`reveal` を付けない）。利用者は取り消して続ける（prd/13 §5.2）
      return { body: answer, status: 200 as const };
    case 'done':
      return { body: { ...answer, ...reveal }, status: 200 as const };
  }
}

export const drillRoutes = new Hono()
  // 🔴 **答えを含む列は返さない**（`answerMove` / `candidates` / `playedMove`）。
  // 渡した時点で答えが見えているのと同じで、専用ページにした意味が消える（prd/13 §7）。
  // 棋譜名・対局者も伏せる——解答後に `POST /drills/:kifuNo/:moveNumber/:kind/answer` が返す。
  // ⚠ 問題を指す組（棋譜の番号・手数・種類。prd/14 §4.4）は返す——URL に載せて同じ問題へ戻るため
  // 入口（`mode`）ごとに選ぶ（prd/13 §6.4）。`since`（この回の開始時刻）以降に記録した問題は選ばない（§7.6）。
  // 在庫が尽きたら `drill: null`。`now` は server の時刻で、web はこの回の最初の値を `since` に使う
  .get('/drills/next', sessionRequired, zv('query', drillNextQuerySchema), async (c) => {
    const now = new Date().toISOString();
    const drill = await pickNextDrill(c.get('tx'), c.get('userId'), c.req.valid('query'));
    return c.json({ drill, now });
  })
  // ホームの数（入口ごとの在庫。prd/13 §7.5）。🔒 正答率は返さない（§10）
  .get('/drills/counts', sessionRequired, async (c) =>
    c.json(await drillCounts(c.get('tx'), c.get('userId'))),
  )
  // 問題の一覧（prd/13 §7.7）。🔴 **答えを含む列は返さない**（`/drills/next` と同じ規則）
  .get('/drills', sessionRequired, zv('query', drillListQuerySchema), async (c) =>
    c.json(await listDrills(c.get('tx'), c.get('userId'), c.req.valid('query'))),
  )
  // 一覧から名指しで開いた 1 問（prd/13 §5.4）。返す形は `/drills/next` と同じ。
  // 問題は（棋譜の番号・手数・種類）で指す（prd/14 §4.4）
  .get(
    '/drills/:kifuNo/:moveNumber/:kind',
    sessionRequired,
    zv('param', drillRefParam),
    async (c) => {
      const ref = c.req.valid('param');
      const now = new Date().toISOString();
      const drill = await loadDrillQuestion(c.get('tx'), c.get('userId'), ref);
      if (!drill) return c.json({ error: '出題が見つかりません' } as const, 404);
      // `now` も `/drills/next` と同じく載せる。名指しで開いた問題（保存した URL・一覧から）から回が始まっても、
      // 最初の解答より前に回の開始時刻が決まるように（レビュー `OCL-BB10F0BB`。prd/13 §7.6）
      return c.json({ drill, now });
    },
  )
  // その問題の解答履歴（prd/13 §7.7）。web は解いた後にだけ呼ぶ（正解の記録の手は答えそのもの）。
  // 全体の解答履歴の口（`/drills/attempts`）は 2026-10-23 に外した
  .get(
    '/drills/:kifuNo/:moveNumber/:kind/attempts',
    sessionRequired,
    zv('param', drillRefParam),
    async (c) => {
      const ref = c.req.valid('param');
      const drill = await loadDrill(c.get('tx'), c.get('userId'), ref);
      if (!drill) return c.json({ error: '出題が見つかりません' } as const, 404);
      return c.json(await listDrillAttemptsOf(c.get('tx'), c.get('userId'), ref));
    },
  )
  // 「自明だった」の取り消し（prd/13 §7.7）。除外の行そのものを消すので解答履歴は残る
  .post(
    '/drills/:kifuNo/:moveNumber/:kind/unexclude',
    sessionRequired,
    zv('param', drillRefParam),
    async (c) => {
      const drill = await loadDrill(c.get('tx'), c.get('userId'), c.req.valid('param'));
      if (!drill) return c.json({ error: '出題が見つかりません' } as const, 404);
      await unexcludeDrill(c.get('tx'), c.get('userId'), drill.id);
      return c.json({ ok: true } as const);
    },
  )
  // 「自明だった」で以後の出題から外す（prd/13 §7）。
  // 🔒 印は**履歴側**に置く——出題を作り直しても残るようにするため（prd/13 §6.2）
  .post(
    '/drills/:kifuNo/:moveNumber/:kind/exclude',
    sessionRequired,
    zv('param', drillRefParam),
    async (c) => {
      const drill = await loadDrill(c.get('tx'), c.get('userId'), c.req.valid('param'));
      if (!drill) return c.json({ error: '出題が見つかりません' } as const, 404);
      // 以下の `id` は出題の行の ID（内部の値。記録と手順の記憶に使い、応答には載せない）
      const { id } = drill;
      await recordAttempt(c.get('tx'), {
        drillId: id,
        ownerId: drill.ownerId,
        move: null,
        verdict: null,
        lossCp: null,
        excluded: true,
      });
      forgetLine(id);
      return c.json({ ok: true } as const);
    },
  )
  // 「諦めて答えを見る」（prd/13 §5.3・2026-10-19 決定）。**不正解として記録する**
  // （`verdict: 'wrong'`・`move: null`・`line` はそこまで確定した手順）。応答は解答の口の `done` と同じ形。
  // `line` は確定済みの手順（最後は受方の応手か空）。`best` は空のみ、`mate` は受け付ける正解手順
  // （元の pv・覚えた別解）のどれかの先頭と一致すること。違えば 400。
  // `practice: true`（解答後のやり直し）は記録しない
  .post(
    '/drills/:kifuNo/:moveNumber/:kind/give-up',
    smallBody,
    sessionRequired,
    zv('param', drillRefParam),
    zv(
      'json',
      z.object({
        line: z.array(z.string().min(2).max(8)).max(64),
        practice: z.boolean().optional(),
      }),
    ),
    async (c) => {
      const { line, practice } = c.req.valid('json');
      const drill = await loadDrill(c.get('tx'), c.get('userId'), c.req.valid('param'));
      if (!drill) return c.json({ error: '出題が見つかりません' } as const, 404);
      const { id } = drill;
      if (!isGiveUpLine(drill.kind, line, [recallLine(id), drill.answerPv])) {
        return c.json({ error: '手順が出題と噛み合いません' } as const, 400);
      }
      if (!practice) {
        await recordAttempt(c.get('tx'), {
          drillId: id,
          ownerId: drill.ownerId,
          move: null,
          line,
          verdict: 'wrong',
          lossCp: null,
        });
      }
      forgetLine(id);
      return c.json({
        status: 'done' as const,
        verdict: 'wrong' as const,
        lossCp: null,
        gaveUp: true as const,
        ...drillReveal(drill, line),
      });
    },
  )
  // 解答（prd/13 §5）。**採点は server が持つ**——候補手と正解手をクライアントへ
  // 先に渡さないための置き場所でもある（上記 `/drills/next`）。
  // `line` は**出題局面からの全手順**（受方の応手を含み、最後がユーザーの手）。
  // `best` は 1 手、`mate` は詰み上がりまで積み上がる（prd/13 §5.2）。
  // 詰将棋で間違えた手（王手でない・詰まない）は `miss` を返し、利用者はその手を取り消して続ける（答えは載せない）。
  // `practice: true` は記録しない（最初の間違い・答えを見た後の操作。web が画面の状態で付ける）
  //
  // 候補手の外の手（詰将棋で正解手順を外れた手）は名指し評価で採点する。次の一手は読む場所が解析の担当（prd/14 §5.7）で決まる:
  // 担当 `worker` は手元 worker にジョブを積み（`pending`）、担当 `browser` は「この局面のこの手を名指しで読んで」
  // （`evaluate`）を返す。ブラウザは読んだ結果を `evaluation` に付けて同じ解答を送り直し、判定は server が行う。
  // 詰将棋は担当によらず `evaluate`（詰将棋の判定の読み方。prd/13 §5.5）。ブラウザが読めないと `browserUnavailable` で
  // 申告してきたら、担当 `worker` だけ手元 worker に回す
  // 🔒 ブラウザから届く評価は信用できない入力なので、Origin の検査・本文の上限・形の検証（`shared` の
  // `drillNamedEvaluationSchema`）を掛け、評価の手が解答の手と一致することも確かめる（prd/14 §5.8）
  .post(
    '/drills/:kifuNo/:moveNumber/:kind/answer',
    smallBody,
    sessionRequired,
    zv('param', drillRefParam),
    zv(
      'json',
      z.object({
        line: z.array(z.string().min(2).max(8)).min(1).max(64),
        // 採点の線引きは**閲覧者の設定**（prd/13 §5.1）。届かなければ既定
        correctMargin: z.number().int().min(0).max(10000).optional(),
        closeMargin: z.number().int().min(0).max(10000).optional(),
        // ブラウザの名指し評価（`evaluate` を受けたブラウザが付けて送り直す。prd/13 §5.3）
        evaluation: drillNamedEvaluationSchema.optional(),
        // 「この端末では読めない」の申告（詰将棋。担当 worker なら手元 worker で判定する。prd/13 §5.5）
        browserUnavailable: z.boolean().optional(),
        // 練習（解答後の「最初からやり直す」）。判定は返すが記録しない（prd/13 §5.3）
        practice: z.boolean().optional(),
      }),
    ),
    async (c) => {
      const { line, correctMargin, closeMargin, evaluation, practice, browserUnavailable } = c.req.valid('json');
      const drill = await loadDrill(c.get('tx'), c.get('userId'), c.req.valid('param'));
      if (!drill) return c.json({ error: '出題が見つかりません' } as const, 404);
      // 出題の行の ID（内部の値。記録と手順の記憶に使い、応答には載せない。prd/14 §4.4）
      const { id } = drill;
      const scoring: DrillScoring = {
        correctMargin: correctMargin ?? DEFAULT_SCORING.correctMargin,
        closeMargin: closeMargin ?? DEFAULT_SCORING.closeMargin,
      };

      // 🔴 **手順が問いに対応していることを、局面を作る前に確かめる**
      // （レビュー `OCL-41F41851`）。任意の派生局面を作らせると、**別の局面で採点して
      // 出題局面の最善値と比べる**ことになり、採点も解答履歴も問いと噛み合わなくなる。
      // 🔴 **元の正解手順と覚えた別解のどちらかの先頭と一致すれば受ける**（2026-10-19 決定。prd/13 §5.2）。
      // 覚えた別解だけで照らすと、「最初からやり直す」で元の手順を指したときに 400 になる
      const mateMatch = drill.kind === 'mate' ? matchMateLine([recallLine(id), drill.answerPv], line) : null;
      const prefix = line.slice(0, -1);
      if (drill.kind === 'best' ? line.length !== 1 : mateMatch?.state === 'mismatch') {
        return c.json({ error: '手順が出題と噛み合いません' } as const, 400);
      }

      // 出題局面 → `line` の 1 手前まで進めた局面。ここがユーザーの手を指す局面
      const base = drillPosition(drill.usiMoves, drill.moveNumber);
      if (!base) return c.json({ error: '出題局面を再現できません' } as const, 409);
      const move = line[line.length - 1];
      // 🔒 **評価の手が解答の手と違えば受けない**（別の手の評価で採点させない。prd/14 §5.8）
      if (evaluation && evaluation.move !== move) {
        return c.json({ error: '評価の手が解答と噛み合いません' } as const, 400);
      }
      const state = applyLine(base, prefix);
      if (!state) return c.json({ error: '手順を再現できません' } as const, 400);

      // エンジンに渡す前の検証（prd/12 §2.5）。合法性は問わないが、
      // クラッシュ・ハングさせうる手はここで落とす
      const check = validateMoveOnPosition(state, move);
      if (!check.ok) {
        return c.json(
          { error: 'その手は指せません', violations: check.violations },
          400,
        );
      }
      // 🔴 **駒の動き方も見る**（レビュー `OCL-1A2B07B9`）。上の検証は**合法性を問わない**
      // （検討盤のフル編集も同じ道を通るため）ので、歩を横に動かす手は素通りしてエンジンまで届く。
      // **出題の解答は実際に指せた手でなければ意味が無い**ので、この経路だけで足す
      if (!isReachableMove(state, move)) {
        return c.json({ error: 'その手は指せません' } as const, 400);
      }

      // エンジンに回すときの共通の入力。担当（prd/14 §5.7）は回すときにだけ読む
      const engineInput = async () => ({
        tx: c.get('tx'),
        userId: c.get('userId'),
        assignee: await analysisAssigneeOf(c.get('tx'), c.get('userId')),
        ...(evaluation ? { browserEvaluation: { candidate: evaluation.candidate } } : {}),
        ...(browserUnavailable ? { browserUnavailable: true } : {}),
      });

      // 解答後にだけ返す情報（ネタバレ回避。prd/13 §7）。棋譜は番号で返す（prd/14 §4.4）
      const reveal = drillReveal(drill, line);
      /** 解答の記録。🔒 練習（`practice`）は書かない */
      const record = async (verdict: 'correct' | 'close' | 'wrong', lossCp: number | null) => {
        if (practice) return;
        await recordAttempt(c.get('tx'), { drillId: id, ownerId: drill.ownerId, move, line, verdict, lossCp });
      };

      if (drill.kind === 'mate' && mateMatch) {
        // 🔴 **王手でない手は間違い**（prd/13 §5.2・2026-10-19 決定）。エンジンの mate は静かな手も
        // 詰みと数えるので、エンジン（棋譜解析の再利用・worker・ブラウザ）に回す前に盤面で見る。
        // 🔒 ブラウザに `evaluate` を返さない。手数の上限は設けない（王手の連続で詰むなら回り道でも別解）。
        // 終わりにはしない（`miss`。利用者は取り消して続ける）。🔒 **答えは載せない**。
        // 不正解は記録する（最初に間違えた時点。以降は web が `practice` で送る）
        if (!givesCheck(state, move, state.sideToMove)) {
          await record('wrong', null);
          return c.json({ status: 'miss' as const, wrongReason: 'not_check' as const });
        }
        const step = mateMatch;
        if (step.state === 'match') {
          if (!step.solved) {
            // 途中。受方の応手だけ返す（**残りの手順は渡さない**）
            return c.json({ status: 'continue' as const, reply: step.reply });
          }
          await record('correct', null);
          forgetLine(id);
          // ⚠ `lossCp` は必ず載せる（mate では常に null）。応答の形を分岐で変えない
          return c.json({
            status: 'done' as const,
            verdict: 'correct' as const,
            lossCp: null,
            ...reveal,
          });
        }
        // 手順から外れた。**別解かもしれない**のでエンジンに聞く（prd/13 §5.2）。
        // 詰将棋は担当によらずブラウザで読み、上限は残り手数で決める（prd/13 §5.5）
        const deviated = await answerWithEngine(
          {
            ...(await engineInput()),
            drill,
            state,
            move,
            line,
            scoring,
            practice,
            mateRemainingPlies: step.state === 'deviated' ? step.remainingPlies : 0,
          },
          reveal,
        );
        return c.json(deviated.body, deviated.status);
      }

      // 次の一手。**出題時の候補手にあれば往復ゼロで採点する**（prd/13 §5.1）
      const scored = scoreFromCandidates(drill, move, scoring);
      if (scored) {
        await record(scored.verdict, scored.lossCp);
        return c.json({ status: 'done' as const, ...scored, ...reveal });
      }
      const resolved = await answerWithEngine(
        { ...(await engineInput()), drill, state, move, line, scoring, practice },
        reveal,
      );
      return c.json(resolved.body, resolved.status);
    },
  );
