import { useEffect, useState } from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { client } from '../lib/honoClient';
import { getSelfNames } from '../lib/self';
import {
  DEFAULT_MATE_MAX,
  loadMateMax,
  MAX_MATE_MAX,
  MIN_MATE_MAX,
  isValidMateMax,
  useMateMax,
} from '../lib/mateMax';
import {
  buildTacticTree,
  DEFAULT_STATS_ORDER,
  DEFAULT_STATS_SORT,
  describeExcluded,
  formatRate,
  LOW_SAMPLE_GAMES,
  PERIOD_PRESET_LABELS,
  PERIOD_PRESETS,
  periodRange,
  presetOf,
  rate,
  totalExcluded,
  type PeriodPreset,
  type StatsOrder,
  type StatsSort,
  type StatsTreeRow,
} from '../lib/statsTactics';
import type { KifuListSearch } from './index';

/**
 * URL に持つのは**集計そのものを変える条件だけ**（期間と詰み手数）。
 *
 * ⚠ **並べ替えは URL に置かない。** server への問い直しを伴わない表示だけの状態であるうえ、
 * TanStack Router は**全ルートの検索スキーマを 1 つに合流させる**ので、`sort` / `order` を
 * ここでも使うと一覧の `sort`（対局日時 / 登録日時 / タイトル）と値の型が衝突する。
 *
 * 生成される routeTree がこの型を参照するため export が要る。
 */
export interface StatsSearch {
  from?: string;
  to?: string;
  /** 取りこぼしと見なす詰み手数の上限。未指定なら `/settings` の既定値（prd/09 §5） */
  mateMax?: number;
}

/** `<input type="date">` が返す `YYYY-MM-DD` だけを受ける */
function dateParam(raw: unknown): string | undefined {
  return typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? raw
    : undefined;
}

export const Route = createFileRoute('/stats')({
  validateSearch: (search: Record<string, unknown>): StatsSearch => {
    const mateMax = Number(search.mateMax);
    return {
      from: dateParam(search.from),
      to: dateParam(search.to),
      // ⚠ **既定値でも URL から落とさない。** 落とすと保存された既定値（`/settings`）に
      // 戻ってしまい、10 を選んだのに 8 で集計される、という食い違いが起きる
      mateMax: isValidMateMax(mateMax) ? mateMax : undefined,
    };
  },
  // ⚠ **`mateMax` は依存に入れる。** 取りこぼしは `candidate_moves` を読まないと出せず、
  // ブラウザには送れないので、変えれば server に問い直す（prd/09 §6.3）
  loaderDeps: ({ search }) => ({
    from: search.from,
    to: search.to,
    mateMax: search.mateMax ?? loadMateMax(),
  }),
  loader: async ({ deps }) => {
    // server は「自分」を知らない（VITE_SELF_NAMES ∪ VITE_SWARS_USER_ID が単一の正。prd/09 §4）。
    // 名前候補が無いと自分の側が決まらず、全局が「自分未確定」で除外されるので問い合わせない
    const self = getSelfNames();
    if (self.length === 0) return { stats: null, error: null };
    try {
      const res = await client.api.stats.tactics.$get({
        query: {
          self: self.join(','),
          mateMax: deps.mateMax,
          from: deps.from,
          to: deps.to,
        },
      });
      if (!res.ok)
        return { stats: null, error: `サーバーエラー (${res.status})` };
      return { stats: await res.json(), error: null };
    } catch {
      return { stats: null, error: 'サーバーに接続できません' };
    }
  },
  component: StatsPage,
});

/**
 * 帰属バッジ（prd/09 §2.2）。**手番固有には付けない**——このページの行は
 * 既定で「相手が採った戦型」なので、説明が要るのはそこから外れるラベルだけ。
 */
const ATTRIBUTION_BADGE: Record<string, { text: string; title: string }> = {
  trigger: {
    text: '双方',
    title: '双方がその戦型なので、相手の型でもある（分母は側を見ない）',
  },
  game: {
    text: '対局',
    title: 'どちらのものでもない対局全体の戦型（分母は側を見ない）',
  },
};

function StatsPage() {
  const { stats, error } = Route.useLoaderData();
  const { from, to, mateMax: mateMaxParam } = Route.useSearch();
  const navigate = useNavigate();
  const { mateMax: storedMateMax, setMateMax } = useMateMax();
  const mateMax = mateMaxParam ?? storedMateMax;
  const [sort, setSort] = useState<StatsSort>(DEFAULT_STATS_SORT);
  const [order, setOrder] = useState<StatsOrder>(DEFAULT_STATS_ORDER);

  const updateSearch = (patch: StatsSearch) =>
    navigate({
      to: '/stats',
      search: (prev: StatsSearch) => ({ ...prev, ...patch }),
    });

  // 列ヘッダのクリックで並べ替える（prd/09 §2.4）。同じ列をもう一度押したら昇降を反転
  const toggleSort = (next: StatsSort) => {
    if (next === sort) {
      setOrder(order === 'desc' ? 'asc' : 'desc');
      return;
    }
    setSort(next);
    setOrder(DEFAULT_STATS_ORDER);
  };

  // ⚠ **両端を明示的に書く。** `periodRange` は開けたい端のキーを持たないので、
  // そのまま流し込むと前のカスタム指定（`to` など）が消えずに残る
  const changePreset = (preset: PeriodPreset) => {
    const range = periodRange(preset, new Date());
    updateSearch({ from: range.from, to: range.to });
  };

  // 詰み手数は**打鍵ごとに反映しない**。1 打鍵ごとに server の集計をやり直すことになり、
  // 取りこぼしは `candidate_moves` への `EXISTS` を含む重いクエリ（prd/09 §6.2）。
  // 空欄や途中の値を弾いて入力を止めないよう、入力欄はドラフトを持つ（一覧の検索欄と同じ形）
  const [mateMaxDraft, setMateMaxDraft] = useState(String(mateMax));

  // 戻る/進む・`/settings` での変更など、こちら以外の理由で値が変わったら入力欄を追従させる
  useEffect(() => {
    setMateMaxDraft(String(mateMax));
  }, [mateMax]);

  useEffect(() => {
    const value = Number(mateMaxDraft);
    if (!isValidMateMax(value) || value === mateMax) return;
    const timer = setTimeout(() => {
      // このページの条件（URL）と次に開いたときの既定値（localStorage）の両方を動かす
      setMateMax(value);
      updateSearch({ mateMax: value });
    }, 400);
    return () => clearTimeout(timer);
  }, [mateMaxDraft, mateMax]);

  const preset = presetOf({ from, to }, new Date());
  const rows = stats ? buildTacticTree(stats.rows, sort, order) : [];
  const excludedTotal = stats ? totalExcluded(stats.excluded) : 0;

  // 一覧への導線（prd/09 §7）。期間はそのまま引き継ぎ、側は帰属で決める
  // （角換わり・相掛かりは側で絞れないので付けない）。
  //
  // ⚠ **母集団も渡す。** 集計の対象局は「自分の側が確定し、勝敗がついた対局」（prd/09 §4）で、
  // 戦型・側・期間だけでは引き分け・結果不明・自分未確定が一覧に混ざり、表の局数より
  // 件数が多くなる（指摘 `OCL-35520A6B`。§2.1 が約束した一致が崩れる）。
  // 取りこぼしのセルは分子が「解析済み」に限られるので `status` も揃える
  // （途中まで解析された棋譜に部分的な `candidateMoves` が残りうる。指摘 `OCL-2D4D27E5`）。
  const listSearch = (
    row: StatsTreeRow,
    missedMate?: number,
  ): KifuListSearch => ({
    tactic: row.label,
    tacticSide: row.attribution === 'side' ? 'opponent' : undefined,
    outcome: 'decided',
    status: missedMate === undefined ? undefined : 'analyzed',
    missedMate,
    from,
    to,
  });

  const sortIndicator = (column: StatsSort) =>
    column === sort ? (order === 'desc' ? ' ↓' : ' ↑') : '';

  return (
    <div>
      <h2 className="text-2xl font-bold mb-1">戦型別成績</h2>
      {/* 主軸は「相手が何を採ったか」（prd/09 §1）。ここを取り違えると表全体を誤読する */}
      <p className="mb-4 text-sm text-base-content/70">
        <strong>相手が採った戦型</strong>
        ごとの成績。角換わり・相掛かりのように双方の戦型となるラベルは
        側を見ずに数えます。
      </p>

      {stats === null && !error ? (
        <div className="alert alert-warning">
          自分の名前候補が設定されていないため集計できません（
          <code>VITE_SELF_NAMES</code> / <code>VITE_SWARS_USER_ID</code>）。
          自分の側が決まらないと「相手の戦型」も勝敗も決まりません。
        </div>
      ) : error ? (
        <div className="alert alert-warning">{error}</div>
      ) : (
        stats && (
          <>
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <select
                className="select select-sm select-bordered"
                value={preset ?? 'custom'}
                onChange={(e) => changePreset(e.target.value as PeriodPreset)}
                aria-label="期間"
              >
                {PERIOD_PRESETS.map((p) => (
                  <option key={p} value={p}>
                    {PERIOD_PRESET_LABELS[p]}
                  </option>
                ))}
                {/* カスタムはここから選ぶものではなく、日付を直接いじった結果なので選べない */}
                {preset === null && (
                  <option value="custom" disabled>
                    カスタム
                  </option>
                )}
              </select>
              <div className="flex items-center gap-1">
                <input
                  type="date"
                  className="input input-sm input-bordered"
                  value={from ?? ''}
                  max={to}
                  onChange={(e) =>
                    updateSearch({ from: e.target.value || undefined })
                  }
                  aria-label="期間の開始日"
                />
                <span className="text-base-content/60">〜</span>
                <input
                  type="date"
                  className="input input-sm input-bordered"
                  value={to ?? ''}
                  min={from}
                  onChange={(e) =>
                    updateSearch({ to: e.target.value || undefined })
                  }
                  aria-label="期間の終了日"
                />
              </div>
              <label className="flex items-center gap-1 text-sm">
                取りこぼし
                <input
                  type="number"
                  className="input input-sm input-bordered w-16"
                  value={mateMaxDraft}
                  min={MIN_MATE_MAX}
                  max={MAX_MATE_MAX}
                  step={1}
                  onChange={(e) => setMateMaxDraft(e.target.value)}
                  aria-label="取りこぼしと見なす詰み手数の上限"
                />
                手詰以下
              </label>
            </div>

            {/* 局数の合計は総局数を超える（各行は独立した問いへの答え。prd/09 §2.1）ので、
                総局数は表の外に別掲して誤読を防ぐ */}
            <div className="mb-4 text-sm text-base-content/60">
              対象 {stats.totalGames} 局
              {excludedTotal > 0 && (
                <>
                  {' / '}除外 {excludedTotal} 局（
                  {describeExcluded(stats.excluded)}）
                </>
              )}
            </div>

            {rows.length === 0 ? (
              <p className="text-base-content/60">
                この期間に集計できる対局がありません。
              </p>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="table table-sm">
                    <thead>
                      <tr>
                        <th rowSpan={2}>戦型</th>
                        <th colSpan={2} className="text-center">
                          全体
                        </th>
                        <th colSpan={2} className="text-center">
                          先手時
                        </th>
                        <th colSpan={2} className="text-center">
                          後手時
                        </th>
                        {/* 勝率とは分母が違う（解析済みの負け局）ことを見出しで明示する（prd/09 §3.1） */}
                        <th
                          rowSpan={2}
                          className="text-right"
                          title={`${mateMax}手詰以下を逃して落とした局 / 解析済みの負け局`}
                        >
                          取りこぼし
                        </th>
                      </tr>
                      <tr>
                        <th className="text-right">
                          <button
                            className="link link-hover"
                            onClick={() => toggleSort('games')}
                          >
                            局数{sortIndicator('games')}
                          </button>
                        </th>
                        <th className="text-right">
                          <button
                            className="link link-hover"
                            onClick={() => toggleSort('winRate')}
                          >
                            勝率{sortIndicator('winRate')}
                          </button>
                        </th>
                        <th className="text-right">局数</th>
                        <th className="text-right">勝率</th>
                        <th className="text-right">局数</th>
                        <th className="text-right">勝率</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => {
                        const badge = ATTRIBUTION_BADGE[row.attribution];
                        // 局数の少ない行は淡色にするだけで隠さない（prd/09 §2.4）
                        const faint = row.games < LOW_SAMPLE_GAMES;
                        return (
                          <tr
                            key={row.label}
                            className={faint ? 'text-base-content/50' : ''}
                          >
                            {/* ⚠ **折り返さない。** 表は横スクロールする（`overflow-x-auto`）ので
                              幅を詰める必要が無く、狭い画面ではラベルが 1 文字ずつ縦に割れる */}
                            <td className="whitespace-nowrap">
                              {/* 階層は IMPLIES をそのまま使う（prd/09 §2.3）。
                                親の局数は子を含む包含関係であって子の合計ではない */}
                              <span
                                className="inline-flex items-center gap-1"
                                style={{ paddingLeft: `${row.depth}rem` }}
                              >
                                <Link
                                  to="/"
                                  search={listSearch(row)}
                                  className="link"
                                >
                                  {row.label}
                                </Link>
                                {badge && (
                                  <span
                                    className="badge badge-outline badge-xs"
                                    title={badge.title}
                                  >
                                    {badge.text}
                                  </span>
                                )}
                              </span>
                            </td>
                            <td className="text-right tabular-nums">
                              {row.games}
                            </td>
                            <td className="text-right tabular-nums">
                              {formatRate(rate(row.wins, row.games))}
                            </td>
                            <td className="text-right tabular-nums">
                              {row.senteGames}
                            </td>
                            <td className="text-right tabular-nums">
                              {formatRate(rate(row.senteWins, row.senteGames))}
                            </td>
                            <td className="text-right tabular-nums">
                              {row.goteGames}
                            </td>
                            <td className="text-right tabular-nums">
                              {formatRate(rate(row.goteWins, row.goteGames))}
                            </td>
                            <td className="text-right tabular-nums whitespace-nowrap">
                              {row.analyzedLosses === 0 ? (
                                <span title="解析済みの負け局がありません">
                                  −
                                </span>
                              ) : (
                                <>
                                  {/* 取りこぼしが 0 なら飛び先が 0 件になるのでリンクにしない */}
                                  {row.missedMateLosses > 0 ? (
                                    <Link
                                      to="/"
                                      search={listSearch(row, mateMax)}
                                      className="link"
                                    >
                                      {row.missedMateLosses}
                                    </Link>
                                  ) : (
                                    row.missedMateLosses
                                  )}
                                  {' / '}
                                  {row.analyzedLosses}
                                  <span className="ml-1 text-base-content/60">
                                    (
                                    {formatRate(
                                      rate(
                                        row.missedMateLosses,
                                        row.analyzedLosses,
                                      ),
                                    )}
                                    )
                                  </span>
                                </>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {/* 表の読み方の注記なので、表があるときだけ出す。
                    ⚠ 横スクロールする器の**外**に置く（一緒に流れていくと読めない） */}
                <p className="mt-3 text-xs text-base-content/60">
                  局数の合計は対象局数を超えます（相手が石田流なら
                  <code>石田流</code>・<code>三間飛車</code>・
                  <code>振り飛車</code>
                  のすべてに 1 局として乗るため）。{LOW_SAMPLE_GAMES}
                  局未満の行は淡色にしていますが、集計からは外していません。
                  {mateMax !== DEFAULT_MATE_MAX && (
                    <>（取りこぼしの詰み手数は {mateMax} 手詰以下）</>
                  )}
                </p>
              </>
            )}
          </>
        )
      )}
    </div>
  );
}
