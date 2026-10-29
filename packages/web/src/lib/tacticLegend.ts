/**
 * 戦型タグの色分けの凡例（`components/TacticTags.tsx` の `TacticLegend`）を、ページに出ている棋譜から組む。
 */
import { attributionOf, suppressForDisplay, type TacticLabel } from 'shared';

/** 主体の手番（prd/11 §4）。null は「自分の側が決まらない」 */
export type UserSide = 'sente' | 'gote' | null;

/**
 * その棋譜のタグが**どの色分けを使うか**。凡例を組み立てる側が使う。
 *
 * ⚠ **自分 / 相手の色が付くのは手番固有（`attribution === 'side'`）のタグだけ。**
 * 対局帰属（`相掛かり`）ときっかけ帰属（`角換わり`）は中立色なので、それしか表示されない
 * 棋譜は色分けの凡例の根拠にならない（指摘 OCL-C513D3E7）。`null` はその行を数えない意味。
 *
 * 抑制後で見るのは、`implies` に畳まれて手番固有のタグが 1 つも残らない場合があるため
 * （`相掛かり` が双方の `居飛車` を隠すと、表示は中立タグ 1 つだけになる）。
 */
export function legendModeOf(
  tactics: TacticLabel[],
  userSide: UserSide,
): 'self' | 'unresolved' | null {
  const hasSideTag = suppressForDisplay(tactics).some(
    (t) => attributionOf(t.label) === 'side',
  );
  if (!hasSideTag) return null;
  return userSide === null ? 'unresolved' : 'self';
}

/**
 * ページに並ぶ棋譜の色分けを合わせて、凡例に出す分け方を決める（混在するなら両方）。
 * ⚠ 凡例は**このページに実際に出ている分け方**から組む。名前候補の設定有無で決めると、
 * 自分が参加していない対局・名前の表記が違う対局・双方が候補に一致する対局で ▲△ 表示になり、凡例が嘘になる（指摘 OCL-66ED0D3A）
 */
export function legendModesOf(
  rows: readonly { tactics: TacticLabel[]; userSide: UserSide }[],
): { self: boolean; unresolved: boolean } {
  const modes = rows.map((row) => legendModeOf(row.tactics, row.userSide));
  return { self: modes.includes('self'), unresolved: modes.includes('unresolved') };
}
