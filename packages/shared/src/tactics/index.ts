/**
 * 戦型判定（prd/01 §6）。
 *
 * **`usiMoves` だけで決まる派生値**で、エンジン解析を必要としない。正は指し手列であって
 * 保存値ではないので、いつでも再計算できることを契約にする（prd/01 §6.4）。
 */
import { buildPositions, type BoardState, type Side } from '../board';
import {
  ALL_KINDS,
  features,
  type CaptureKind,
  type Feat,
} from './features';
import {
  INTERNAL,
  Lens,
  PRIMARY,
  SECONDARY,
  type Timeline,
} from './definitions';

export type { CaptureKind, Feat } from './features';
export { ALL_KINDS, features, flipBoard } from './features';
export { INTERNAL, PRIMARY, SECONDARY, Lens } from './definitions';
export type { Internal, Primary, Secondary, Timeline } from './definitions';

/** 保存するラベル 1 行。`kifuTactics` の 1 レコードに対応（prd/03 §2.1） */
export interface TacticLabel {
  /** ラベルの**帰属先**。「立った手番」ではない（prd/03 §2.1.1） */
  side: Side | 'both';
  label: string;
  /** 成立手数。表示の抑制に使う。**絞り込み条件には使わない**（prd/03 §2.1.2） */
  turn: number;
}

/**
 * ラベルの帰属（prd/01 §6.3）。**`side` の意味がこれで変わる**ので、
 * 表示・絞り込みはこの表を参照する。判定側が単一の出所になる（prd/03 §2.1.1）。
 *
 * - `side`    手番固有。**その側だけ**がその戦型。相手の同意なしに成立する
 * - `trigger` きっかけ帰属。**双方がその戦型**で、`side` は持ち込んだ側
 * - `game`    対局帰属。どちらのものでもない。`side` は `both` の 1 行だけ
 */
export type Attribution = 'side' | 'trigger' | 'game';

const ATTRIBUTION: Record<string, Attribution> = {
  角換わり: 'trigger',
  相掛かり: 'game',
};

export function attributionOf(label: string): Attribution {
  return ATTRIBUTION[label] ?? 'side';
}

/**
 * **帰属が `side` でないラベルの一覧**（`角換わり` / `相掛かり`）。prd/09 §6.1。
 *
 * このラベルは `side` で絞ってはいけない。きっかけ帰属は `side` が「持ち込んだ側」で
 * **双方がその戦型**であり、対局帰属は `both` の 1 行しか持たないので、
 * `side = 自分` / `side = 相手` で絞ると意味が変わる（prd/03 §2.1.1）。
 *
 * ⚠ **参照する側（server の絞り込み・集計、web の UI）で配列を書き直さない。**
 * {@link ATTRIBUTION} から導出しているので、判定にラベルが増えてもここだけで追随できる。
 */
export const NON_SIDE_ATTRIBUTED_LABELS: readonly string[] = Object.entries(ATTRIBUTION)
  .filter(([, a]) => a !== 'side')
  .map(([label]) => label);

/**
 * **対局レベルの関係（相居飛車 / 相振り飛車）は、per-side のラベルが双方に立っているか**で決まる。
 *
 * ⚠ **タグとしては出さない**（2026-08-05 に `対抗形` ごと削除）。双方の per-side タグを見れば
 * 読めるうえ、相振り飛車は**振り先の組み合わせ**（三間飛車 vs 向かい飛車）こそが本体なので、
 * 1 タグに畳むと一番知りたい情報が消える。
 *
 * **残してあるのは絞り込みの語彙として。** 保存しているのは per-side のラベルだけなので
 * （prd/01 §6.3）、「相振り飛車の対局」は `kifuTactics` への `EXISTS` 2 つになる:
 *
 * ```sql
 * EXISTS (… side = 'sente' AND label = '振り飛車')
 * AND EXISTS (… side = 'gote' AND label = '振り飛車')
 * ```
 *
 * **表示を消しても検索は塞がらない。** 定義をここに 1 つ持っておけば、SQL を組む側と
 * 選択肢を出す側が同じものを見る。
 */
export const RELATION_FILTERS: Record<string, string> = {
  /** 双方が居飛車 */
  相居飛車: '居飛車',
  /** 双方が振り飛車 */
  相振り飛車: '振り飛車',
};

/** 保存しないラベル（役割ラベル） */
/**
 * 角交換の役割。**ラベルとしては出さない**（prd/03 §2.1.1）。
 * `角換わり` の `side`（＝持ち込んだ側）を決めるためだけに使う。
 */
const ROLE_LABELS = ['角交換を挑んだ', '角交換に応じた'] as const;

const NOT_STORED = new Set<string>(ROLE_LABELS);

/**
 * **`kifuTactics` に保存されうるラベル名の一覧**（絞り込みの選択肢の語彙）。
 *
 * 役割ラベル（{@link ROLE_LABELS}）は保存しないので含めない。**選択肢を出す側で
 * 配列を書かない**ために名前付きで出す（`NON_SIDE_ATTRIBUTED_LABELS` と同じ理由。prd/09 §6.1）。
 */
export const STORED_TACTIC_LABELS: readonly string[] = [...PRIMARY, ...SECONDARY]
  .map((d) => d.name)
  .filter((name) => !NOT_STORED.has(name));

/**
 * 飛車の振り先で決まる戦法。飛車は 1 つの筋にしか居ないので**相互排他**で、
 * 複数立つのは振り直しを意味する（表示では最初の 1 つだけ出す。prd/03 §2.1.2）。
 */
export const ROOK_PLACE = [
  '中飛車',
  '四間飛車',
  '三間飛車',
  '向かい飛車',
  '右四間飛車',
  '袖飛車',
] as const;

/**
 * ラベルの包含関係（prd/01 §6.3）。**判定条件どうしの含意**であって戦法の分類ではない。
 * 左が立ったら右も必ず立つので、表示では右を隠す。
 *
 * ⚠ **「一般に A は B の一種」で書かない。** 分類は出自の話で、個々の棋譜がその形を通る
 * 保証がない。`右四間飛車`(4八) と `袖飛車`(3八) は振り先が 5 筋より右なので振り飛車を含意せず、
 * `角換わり`・`矢倉` も成立時点の飛車位置しか見ていないので居飛車を含意しない
 * （角交換のあとで振る形が実在する）。
 */
export const IMPLIES: Record<string, string[]> = {
  // 振り先が 8 段の 5〜9 筋なので `_振り飛車` の述語を必ず満たす
  中飛車: ['振り飛車'],
  四間飛車: ['振り飛車'],
  三間飛車: ['振り飛車'],
  向かい飛車: ['振り飛車'],
  // 本組み（7八飛 → 7六飛）も早石田（7八飛 + 7五歩）も `_飛車78` を必ず通る
  石田流: ['三間飛車'],
  // `_飛車先歩交換` ⟹ 2 筋の歩が盤上に無い ⟹ `_飛車先2六`。かつ定義が「振る前」を要求する
  ひねり飛車: ['居飛車'],
  // 飛車が 2六に居る ⟹ 2 筋の歩は 2五以遠 ⟹ `_飛車先2六`
  縦歩取り: ['居飛車'],
  // `右四間飛車` = `_飛車48` かつ成立時点で振っていない。`居飛車` は
  // `_飛車先2六` / `_飛車48` / `_飛車38` のいずれか + 同じ「振っていない」条件なので、
  // **右四間飛車が立てば居飛車の条件は必ず満たされる**（窓も同じ）。袖飛車（`_飛車38`）も同様。
  // ⚠ これは「一般に右四間飛車は居飛車の一種」という分類ではなく**判定条件どうしの含意**。
  // 実測でも 100%（それ以前は 65% / 68% で、差は `居飛車` が飛車先を突かない形を
  // 取りこぼしていた分だった）
  右四間飛車: ['居飛車'],
  袖飛車: ['居飛車'],
  // `_双方飛車先2五` ⟹ `_飛車先2六`。かつ成立時点で振っていないことを定義が要求する
  相掛かり: ['居飛車'],
};

/** `IMPLIES` を推移的に辿る（`石田流` → `三間飛車` → `振り飛車`） */
function impliedBy(label: string, seen = new Set<string>()): Set<string> {
  for (const next of IMPLIES[label] ?? []) {
    if (seen.has(next)) continue;
    seen.add(next);
    impliedBy(next, seen);
  }
  return seen;
}

/**
 * 表示するラベルを絞る（prd/03 §2.1.2 の A）。**per-side の表示タグにだけ掛ける。**
 *
 * ⚠ **関係ラベルの導出（B）をこの出力から行ってはいけない。** B の入力は抑制前の全判定結果。
 *
 * 1. `implies` で含意される一般ラベルを隠す
 * 2. 残った振り先ラベルが複数あれば `turn` が最小のものだけ出す
 */
export function suppressForDisplay(labels: TacticLabel[]): TacticLabel[] {
  // ⚠ **抑制は側ごとに独立して掛ける。** 集合を 1 つで共有すると、先手の `石田流` が
  // **後手の** `三間飛車` まで隠す（PRD は per-side の表示タグへ独立に適用すると定めている）。
  // ただし `both` のラベル（対局帰属）は双方のタグを隠す
  // ——`相掛かり` は「双方が居飛車」を意味するので、両側の `居飛車` が畳まれるのが正しい。
  const hidden: Record<string, Set<string>> = {
    sente: new Set(),
    gote: new Set(),
    both: new Set(),
  };
  for (const l of labels) {
    const targets = l.side === 'both' ? ['sente', 'gote', 'both'] : [l.side];
    for (const h of impliedBy(l.label)) for (const t of targets) hidden[t].add(h);
  }

  const kept = labels.filter((l) => !hidden[l.side].has(l.label));

  // 振り直し: 振り先ラベルは最初に成立したものだけ残す。side ごとに独立して見る
  const firstRookPlace = new Map<string, TacticLabel>();
  for (const l of kept) {
    if (!(ROOK_PLACE as readonly string[]).includes(l.label)) continue;
    const cur = firstRookPlace.get(l.side);
    if (!cur || l.turn < cur.turn) firstRookPlace.set(l.side, l);
  }
  return kept.filter(
    (l) =>
      !(ROOK_PLACE as readonly string[]).includes(l.label) ||
      firstRookPlace.get(l.side) === l,
  );
}

// ============================================================
// 観測窓（prd/01 §6.2）
// ============================================================

/**
 * 各手で新たに手駒に加わった駒種。index = 手数。
 * どちらの側が取ったかは問わない（駒がぶつかった＝駒組みが終わった、という判定なので）。
 */
function captureKindsByTurn(positions: BoardState[]): Set<CaptureKind>[] {
  const out: Set<CaptureKind>[] = [new Set()];
  for (let i = 1; i < positions.length; i++) {
    const kinds = new Set<CaptureKind>();
    for (const side of ['sente', 'gote'] as Side[]) {
      const a = positions[i - 1].hand[side];
      const b = positions[i].hand[side];
      for (const kind of ALL_KINDS) {
        if ((b[kind] ?? 0) > (a[kind] ?? 0)) kinds.add(kind);
      }
    }
    out.push(kinds);
  }
  return out;
}

/**
 * i 手目の角の捕獲が**角交換の一部**か。
 *
 * 角交換は「取る → 取り返す」の 2 手で完了するので、その手または次の手の時点で
 * **双方が角を持ち駒にしている**なら交換とみなす。一方的な角損・角切りは交換ではないので、
 * 通常どおり窓を閉じる。
 */
function isBishopExchange(positions: BoardState[], i: number): boolean {
  for (const j of [i, i + 1]) {
    const p = positions[j];
    if (!p) continue;
    if ((p.hand.sente.B ?? 0) > 0 && (p.hand.gote.B ?? 0) > 0) return true;
  }
  return false;
}

/** 除外集合を与えたときの窓の右端（この手数まで観測してよい） */
function windowLimit(
  captures: Set<CaptureKind>[],
  ignores: CaptureKind[],
  total: number,
  positions: BoardState[],
): number {
  const close = (i: number) => Math.max(1, Math.min(i - 1, total));
  for (let i = 1; i < captures.length; i++) {
    for (const k of captures[i]) {
      if (!ignores.includes(k)) return close(i);
      // 角を除外していても、**交換でない角取り**（一方的な角損・角切り）は開戦なので窓を閉じる
      if (k === 'B' && !isBishopExchange(positions, i)) return close(i);
    }
  }
  return Math.max(1, total);
}

/**
 * **角交換は「駒がぶつかった」に数えない。**
 *
 * 窓の規則（prd/01 §6.2）は「その述語が駒を取った結果を見ているか」で除外を決めるが、
 * それだと飛車の振り先を見るラベルは角を除外せず、**角交換の瞬間に窓が閉じる**。
 * `ダイレクト向かい飛車`（角交換してから 2二飛）が典型で、窓 2〜6 手に対し飛車が振られるのは
 * 8〜10 手目になる。**角交換は序盤の駒組み手順であって開戦ではない**という将棋的な事実は
 * 述語の形とは独立に成り立つので、全ラベル共通の除外として足す。
 * 歩は別扱いのまま（歩がぶつかるのは急戦の仕掛けそのもの）。
 *
 * ⚠ **除外するのは「角交換」であって「角の捕獲」一般ではない。** 開戦後の角損・角切りまで
 * 除外すると、その後の中盤の駒運びを戦型として拾う。交換かどうかは
 * {@link isBishopExchange} が「双方が角を持ち駒にしたか」で判定する。
 */
const ALWAYS_IGNORED: CaptureKind[] = ['B'];

// ============================================================
// 判定
// ============================================================

const INTERNAL_BY_NAME = new Map(INTERNAL.map((d) => [d.name, d]));

// `uses` に書いた名前が実在するかを起動時に検算する（窓の計算が静かに空振りするのを防ぐ）
for (const d of [...PRIMARY, ...SECONDARY]) {
  for (const n of d.uses) {
    if (!INTERNAL_BY_NAME.has(n)) {
      throw new Error(`${d.name} の uses に未定義の内部ラベル: ${n}`);
    }
  }
}

/**
 * 指し手列から戦型ラベルを判定する。**`kifuTactics` に保存する形**で返す。
 *
 * - 役割ラベル（`角交換を挑んだ` 等）は**含まない**（prd/01 §6.3・prd/03 §2.1.1）
 * - `角換わり` は `side` に**持ち込んだ側**を入れた 1 行、`相掛かり` は `both` の 1 行
 * - 立ったラベルは**経由形も含めて全部返す**。表示で絞るのは {@link suppressForDisplay}
 */
export function detectTactics(usiMoves: string[]): TacticLabel[] {
  const positions = buildPositions(usiMoves);
  const total = positions.length - 1;
  if (total < 1) return [];

  const captures = captureKindsByTurn(positions);
  const limitCache = new Map<string, number>();
  const limitFor = (ignores: CaptureKind[]): number => {
    const key = [...ignores].sort().join('');
    let v = limitCache.get(key);
    if (v === undefined) {
      v = windowLimit(captures, ignores, total, positions);
      limitCache.set(key, v);
    }
    return v;
  };

  // ---- 第1層: 内部ラベルの時系列（窓は掛けない。全手数分を持つ）----
  const timelines: Record<Side, Timeline> = { sente: new Map(), gote: new Map() };
  for (const side of ['sente', 'gote'] as Side[]) {
    const featCache: (Feat | undefined)[] = [];
    const featAt = (i: number): Feat =>
      (featCache[i] ??= features(positions[i], side === 'gote', i));
    for (const d of INTERNAL) {
      const tl: boolean[] = new Array(total + 1).fill(false);
      for (let i = 1; i <= total; i++) tl[i] = d.test(featAt(i));
      timelines[side].set(d.name, tl);
    }
  }

  /** そのラベルの窓 = 参照する内部ラベルの除外集合の**和** */
  const lensFor = (side: Side, uses: string[]): Lens => {
    const opp: Side = side === 'sente' ? 'gote' : 'sente';
    const ignores = [
      ...new Set([
        ...uses.flatMap((n) => INTERNAL_BY_NAME.get(n)?.ignores ?? []),
        ...ALWAYS_IGNORED,
      ]),
    ];
    return new Lens(timelines[side], timelines[opp], limitFor(ignores), new Set(uses));
  };

  // ---- 第2層: 一次ラベル ----
  const primary: Record<Side, Map<string, number>> = { sente: new Map(), gote: new Map() };
  /** 伝播する前に**自分の条件で**立った側。きっかけ帰属の手掛かりになる */
  const ownHit: Record<Side, Set<string>> = { sente: new Set(), gote: new Set() };
  for (const side of ['sente', 'gote'] as Side[]) {
    for (const d of PRIMARY) {
      const hit = d.test(lensFor(side, d.uses));
      if (hit !== null) {
        primary[side].set(d.name, hit);
        ownHit[side].add(d.name);
      }
    }
  }
  // 相互的な戦型を相手側へ伝播
  for (const d of PRIMARY) {
    if (!d.mutual) continue;
    for (const side of ['sente', 'gote'] as Side[]) {
      const opp: Side = side === 'sente' ? 'gote' : 'sente';
      const h = primary[opp].get(d.name);
      if (h !== undefined && !primary[side].has(d.name)) primary[side].set(d.name, h);
    }
  }
  // 残余ラベルの取り下げ（**双方の判定を見る**。相手が横歩を取れば局面全体が横歩取り）
  for (const d of PRIMARY) {
    if (!d.excludedBy) continue;
    for (const side of ['sente', 'gote'] as Side[]) {
      const opp: Side = side === 'sente' ? 'gote' : 'sente';
      if (!primary[side].has(d.name)) continue;
      if (d.excludedBy.some((e) => primary[side].has(e) || primary[opp].has(e))) {
        primary[side].delete(d.name);
      }
    }
  }

  // ---- 第3層: 二次ラベル ----
  const labels: Record<Side, Map<string, number>> = {
    sente: new Map(primary.sente),
    gote: new Map(primary.gote),
  };
  for (const side of ['sente', 'gote'] as Side[]) {
    const opp: Side = side === 'sente' ? 'gote' : 'sente';
    for (const d of SECONDARY) {
      const hit = d.test(lensFor(side, d.uses), primary[side], primary[opp]);
      if (hit !== null) labels[side].set(d.name, hit);
    }
  }

  // ---- 帰属に合わせて行へ畳む（prd/03 §2.1.1）----
  const out: TacticLabel[] = [];
  const doneMutual = new Set<string>();
  for (const side of ['sente', 'gote'] as Side[]) {
    for (const [label, turn] of labels[side]) {
      if (NOT_STORED.has(label)) continue;

      const attribution = attributionOf(label);
      if (attribution === 'side') {
        out.push({ side, label, turn });
        continue;
      }
      // きっかけ帰属 / 対局帰属は 1 局 1 行。両手番に立っているので一度だけ出す
      if (doneMutual.has(label)) continue;
      doneMutual.add(label);

      // **成立手数は双方の最小を採る。** 手番ごとに独立して成立時点が決まる
      // （`相掛かり` は自分と相手のどちらが飛車先の歩を交換したかで変わる）が、
      // 1 局 1 行に畳む以上「対局がその戦型になった時点」は早い方でなければならない。
      // 遅い方を採ると、片手番の視点でしかない値が対局全体の値として残る
      const turnBoth = Math.min(
        labels.sente.get(label) ?? Infinity,
        labels.gote.get(label) ?? Infinity,
      );

      if (attribution === 'game') {
        out.push({ side: 'both', label, turn: turnBoth });
        continue;
      }
      out.push({
        side: triggerSideOf(label, labels, ownHit) ?? side,
        label,
        turn: turnBoth,
      });
    }
  }
  return out;
}

/**
 * きっかけ帰属のラベルで「持ち込んだ側」を決める（prd/03 §2.1.1）。
 *
 * 角交換は「取る → 取り返す」の 2 手で完了するので、**先に角を持ち駒にした側**が仕掛けた側。
 * 二次ラベル `角交換を挑んだ` がそれを表す（ラベルとしては保存しない）。
 *
 * 役割が決まらない場合は**自分の条件で先に立った側**へ落とす。`角換わり` は自分の馬が敵陣で
 * 成った形なので、伝播前に立った側が踏み込んだ側になる。
 */
function triggerSideOf(
  label: string,
  labels: Record<Side, Map<string, number>>,
  ownHit: Record<Side, Set<string>>,
): Side | null {
  if (label === '角換わり') {
    const s = labels.sente.has('角交換を挑んだ');
    const g = labels.gote.has('角交換を挑んだ');
    if (s && !g) return 'sente';
    if (g && !s) return 'gote';
  }
  const own = (['sente', 'gote'] as Side[]).filter((side) => ownHit[side].has(label));
  return own.length === 1 ? own[0] : null;
}
