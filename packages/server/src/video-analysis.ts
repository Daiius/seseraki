/**
 * 動画解析で復元した棋譜の取り込み（prd/10 §4）。
 *
 * ⚠ **ロジックはここに置き、route.ts は薄い entry point にする**（`tactics.ts` と同じ立場）。
 * 取り込みの意味論——KIF の合成と往復検証・差分の検出・解析状態のリセット・戦型の同期——は
 * **すべてここに集約する**。復元側（実験パッケージ）に散らさない。
 */
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from './db';
import { kifus, moveAnalyses, videoKifuSources } from './db/schema';
import { composeKifVerified } from './kif/compose';
import { replaceTactics } from './tactics';
import { replacePositions } from './positions';
import { currentUserId, subjectSideFromVideo } from './users';

/**
 * 取り込みの入力（`POST /api/video-analysis/kifus`）。
 * **型はここから導く**（スキーマと型が別々にあると片方だけ直る）。
 */
export const videoKifuInputSchema = z
  .object({
    /** 動画の識別子。列は varchar(32) */
    videoId: z.string().min(1).max(32),
    /** その動画の何局目か（1 始まり） */
    gameIndex: z.number().int().min(1),
    startedAtSec: z.number().int().min(0),
    endedAtSec: z.number().int().min(0),
    /** 画面の下が先手か（録画者の側） */
    bottomIsSente: z.boolean(),
    /** 走査時のコミット（git rev-parse HEAD） */
    extractorRev: z.string().min(1).max(40),
    /** 復元された USI 指し手列。`7g7f` / `8h2b+` / `P*3e` の長さに収まる */
    usi: z.array(z.string().min(4).max(6)).min(1),
    /** 走査の生出力（そのまま保存する） */
    raw: z.record(z.unknown()),
  })
  // 区間は**組として**成り立っていないといけない。個々の値が非負なだけでは
  // 逆転した区間（終了 < 開始）が通り、そのまま保存されて一覧に出る。
  // 🔒 検証はここ 1 箇所に置く（取り込みの経路はこの API だけ。prd/10 §4.1）
  .refine((v) => v.endedAtSec >= v.startedAtSec, {
    message: '区間が逆転している（endedAtSec は startedAtSec 以上）',
    path: ['endedAtSec'],
  });

export type VideoKifuInput = z.infer<typeof videoKifuInputSchema>;

/** 上書きで変わった手。`before` / `after` の片方が null なら手数そのものが変わっている */
export interface UsiDiff {
  moveNumber: number;
  before: string | null;
  after: string | null;
}

/**
 * 旧 USI 列と新 USI 列の差分を取る。
 *
 * 🔒 **これが上書きの唯一の記録になる。** 手数・断片・通し再生の指標がすべて満点でも
 * 成/不成の取り違えは残るので（prd/10 §9）、**USI 列そのものの差分でしか変化を見つけられない**。
 */
export function diffUsiMoves(before: string[], after: string[]): UsiDiff[] {
  const diffs: UsiDiff[] = [];
  for (let i = 0; i < Math.max(before.length, after.length); i++) {
    if (before[i] !== after[i]) {
      diffs.push({
        moveNumber: i + 1,
        before: before[i] ?? null,
        after: after[i] ?? null,
      });
    }
  }
  return diffs;
}

/** 差分を 1 行のログにする。全崩れのときに何百行も出さないよう先頭だけ出す */
export function formatDiff(diffs: UsiDiff[], limit = 10): string {
  const head = diffs
    .slice(0, limit)
    .map((d) => `${d.moveNumber}: ${d.before ?? '(なし)'} → ${d.after ?? '(なし)'}`)
    .join(' / ');
  const rest = diffs.length > limit ? ` ほか ${diffs.length - limit} 件` : '';
  return `${head}${rest}`;
}

/**
 * 一覧に出すタイトル。対局者名が取れないので、動画と局番号で識別する（prd/10 §2.3）。
 * ⚠ 既存棋譜の再取り込みでは**上書きしない**（手で直しているかもしれない）。
 */
export function videoKifuTitle(input: VideoKifuInput): string {
  return `動画 ${input.videoId} 第 ${input.gameIndex} 局`;
}

export interface ImportResult {
  kifuId: number;
  /** 新規に作ったか（false なら上書き） */
  created: boolean;
  /** 指し手列が変わったか。変わったときだけ解析をやり直す */
  changed: boolean;
  diff: UsiDiff[];
}

/**
 * 走査結果を 1 局ぶん取り込む。`(videoId, gameIndex)` が同じものは**上書きする**
 * （prd/10 §4.3。「同じ動画の同じ局」は 1 つの実体）。
 *
 * @throws 合成した KIF が往復しないとき（`composeKifVerified`）
 */
export async function importVideoKifu(
  input: VideoKifuInput,
): Promise<ImportResult> {
  // 🔒 往復しない棋譜は保存しない。合成側か復元側のどちらかが壊れており、
  // どちらであってもそのまま残してよい状態ではない（prd/10 §4.2）
  const kifText = composeKifVerified(input.usi);

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({
        kifuId: videoKifuSources.kifuId,
        usiMoves: kifus.usiMoves,
      })
      .from(videoKifuSources)
      .innerJoin(kifus, eq(kifus.id, videoKifuSources.kifuId))
      .where(
        and(
          eq(videoKifuSources.videoId, input.videoId),
          eq(videoKifuSources.gameIndex, input.gameIndex),
        ),
      );

    const source = {
      videoId: input.videoId,
      gameIndex: input.gameIndex,
      startedAtSec: input.startedAtSec,
      endedAtSec: input.endedAtSec,
      bottomIsSente: input.bottomIsSente,
      extractorRev: input.extractorRev,
      raw: input.raw,
    };

    if (!existing) {
      const [inserted] = await tx
        .insert(kifus)
        .values({
          title: videoKifuTitle(input),
          kifText,
          usiMoves: input.usi,
          source: 'video',
          // 動画解析も「投入した人」が所有者（prd/11 §3）
          ownerId: await currentUserId(tx),
          // 画面の下が録画者なので、主体側はここで決まる（prd/11 §4.1）
          subjectSide: subjectSideFromVideo(input.bottomIsSente),
        })
        .$returningId();
      await tx
        .insert(videoKifuSources)
        .values({ kifuId: inserted.id, ...source });
      await replaceTactics(tx, inserted.id, input.usi);
      await replacePositions(tx, inserted.id, input.usi);
      return { kifuId: inserted.id, created: true, changed: true, diff: [] };
    }

    const diff = diffUsiMoves(existing.usiMoves ?? [], input.usi);
    const changed = diff.length > 0;

    // 録画者の側が変わることはまず無いが、再走査で向きの判定が直ることはある（prd/10 §1 の欠陥 5）
    await tx
      .update(kifus)
      .set({ subjectSide: subjectSideFromVideo(input.bottomIsSente) })
      .where(eq(kifus.id, existing.kifuId));

    // 走査のメタ（コミット・区間・生出力）は、指し手が変わらなくても新しいものに置き換える。
    // 「いつ・どの版で読み直したか」は棋譜が同じでも記録として要る
    await tx
      .update(videoKifuSources)
      .set(source)
      .where(eq(videoKifuSources.kifuId, existing.kifuId));

    if (!changed) {
      return { kifuId: existing.kifuId, created: false, changed: false, diff };
    }

    // 指し手が変わったので解析をやり直させる。既存の reanalyze と同じ形
    // （先に kifus を UPDATE して行ロックを取る。prd/03 §2）。title / memo は温存する
    await tx
      .update(kifus)
      .set({
        kifText,
        usiMoves: input.usi,
        analysisError: null,
        analysisCompletedAt: null,
        analysisRevision: sql`${kifus.analysisRevision} + 1`,
      })
      .where(eq(kifus.id, existing.kifuId));
    await tx.delete(moveAnalyses).where(eq(moveAnalyses.kifuId, existing.kifuId));
    await replaceTactics(tx, existing.kifuId, input.usi);
    await replacePositions(tx, existing.kifuId, input.usi);

    return { kifuId: existing.kifuId, created: false, changed: true, diff };
  });
}
