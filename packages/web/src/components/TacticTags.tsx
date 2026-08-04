import { attributionOf, suppressForDisplay, type TacticLabel } from 'shared';
import type { UserSide } from '../lib/self';

/**
 * 戦型ラベルのタグ表示（prd/03 §2.1.2）。
 *
 * **`side` の意味はラベルによって変わる**ので、色分けは `attributionOf` を見て決める
 * （prd/03 §2.1.1）:
 *
 * | 帰属 | 例 | 表示 |
 * |---|---|---|
 * | 手番固有 | 四間飛車・矢倉 | **自分 / 相手**で色を分ける |
 * | きっかけ帰属 | 角換わり | **双方がその戦型**。片側の色にはせず、持ち込んだ側を ▲△ で示す |
 * | 対局帰属 | 相掛かり | どちらのものでもない。中立の色 |
 *
 * 角換わりを「先手の戦型」として片側の色にすると嘘になる（双方が角換わりであるため）。
 */
export interface TacticTagsProps {
  /** **抑制前の全判定結果**。関係ラベルの導出に要る（prd/03 §2.1.2 の B） */
  tactics: TacticLabel[];
  /** 自分の側。null なら自分/相手で分けず ▲△ で示す */
  userSide: UserSide;
  className?: string;
}

const SIDE_MARK: Record<string, string> = { sente: '▲', gote: '△' };

/**
 * バッジの見た目。**帰属ごとに 1 箇所で決める**（凡例と本体で必ず揃うように）。
 *
 * ⚠ **中立に `badge-soft badge-neutral` を使ってはいけない。** daisyUI の `badge-soft` は
 * 文字色に `--color-neutral` をそのまま使うが、**dark テーマでは `--color-neutral` 自体が
 * 暗色**（L=0.14）なので、暗い背景（L=0.24）に暗い文字が乗って読めなくなる。
 * 実測の明度差は **0.10**（他の色は 0.67〜0.78）。枠線だけの `badge-outline` は
 * light 0.79 / dark 0.72 で両テーマとも読める。
 */
const TONE = {
  /** 自分の戦型 */
  self: 'badge-soft badge-primary',
  /** 相手の戦型 */
  opponent: 'badge-soft badge-secondary',
  /** どちらのものでもない（対局帰属・きっかけ帰属）。**色を持たせない**のが意味に合う */
  neutral: 'badge-outline',
} as const;

/**
 * タグの色分けの凡例。一覧の見出しに置いて「下の行が何なのか」を示す。
 *
 * **タグ側が実際に使っている分け方に合わせる**（そうしないと凡例が嘘になる）:
 * 自分の側が判定できる対局では色で自分 / 相手を分けるので凡例も色、
 * 判定できないときはタグが ▲△ を出すので凡例も ▲△ にする。
 *
 * ⚠ **どちらを出すかは「名前候補が設定されているか」では決まらない**（指摘 OCL-66ED0D3A）。
 * 色分けは `resolveUserSide` が**棋譜ごとに**解決するので、設定済みでも自分が参加していない
 * 対局・対局者名の表記が違う対局・双方が候補に一致する対局は ▲△ 表示になる。
 * **ページに実際に出ている分け方だけを渡すこと。** 混在するなら両方出す（それが事実なので）。
 *
 * 狭い画面では「の戦型」を落として 2 文字にする（列幅を食わないため）。
 */
export function TacticLegend({
  self,
  unresolved,
  className,
}: {
  /** 自分 / 相手の色で分けている行があるか */
  self: boolean;
  /** 自分を特定できず ▲△ で示している行があるか */
  unresolved: boolean;
  className?: string;
}) {
  const items = [
    ...(self
      ? [
          { tone: TONE.self, full: '自分の戦型', short: '自分' },
          { tone: TONE.opponent, full: '相手の戦型', short: '相手' },
        ]
      : []),
    ...(unresolved
      ? [
          { tone: TONE.neutral, full: '▲先手の戦型', short: '▲戦型' },
          { tone: TONE.neutral, full: '△後手の戦型', short: '△戦型' },
        ]
      : []),
  ];
  if (items.length === 0) return null;
  return (
    <div className={`flex flex-wrap gap-1 font-normal ${className ?? ''}`}>
      {items.map((it) => (
        <span key={it.full} className={`badge badge-sm ${it.tone}`}>
          <span className="hidden sm:inline">{it.full}</span>
          <span className="sm:hidden">{it.short}</span>
        </span>
      ))}
    </div>
  );
}

export function TacticTags({ tactics, userSide, className }: TacticTagsProps) {
  if (tactics.length === 0) return null;

  // per-side の表示タグ（implies と振り直しの抑制）。
  // **対局レベルの関係ラベル（相居飛車・相振り飛車）は出さない**——双方のタグを見れば読めるため
  // （2026-08-05 に削除。絞り込みの語彙としては shared の `RELATION_FILTERS` に残っている）
  const shown = suppressForDisplay(tactics);

  return (
    <div className={`flex flex-wrap gap-1 ${className ?? ''}`}>
      {shown.map((t) => {
        const attribution = attributionOf(t.label);
        // 手番固有だけが「自分の戦型 / 相手の戦型」になる
        const isSelf = attribution === 'side' && userSide !== null && t.side === userSide;
        const isOpponent =
          attribution === 'side' && userSide !== null && t.side !== userSide;
        const tone =
          isSelf ? TONE.self
          : isOpponent ? TONE.opponent
          : TONE.neutral;
        // 自分/相手が分かるときは ▲△ を出さない（色で分かるため）。
        // きっかけ帰属は「持ち込んだ側」なので、分かっていても常に出す
        const mark =
          attribution === 'trigger' || (attribution === 'side' && userSide === null)
            ? SIDE_MARK[t.side]
            : '';
        return (
          <span
            key={`${t.side}:${t.label}`}
            className={`badge badge-sm ${tone}`}
            title={
              attribution === 'trigger' ?
                `${SIDE_MARK[t.side]}から持ち込んだ（双方が${t.label}）`
              : attribution === 'game' ? '対局全体の戦型'
              : isSelf ? '自分の戦型'
              : isOpponent ? '相手の戦型'
              : undefined
            }
          >
            {mark}
            {t.label}
          </span>
        );
      })}
    </div>
  );
}
