/**
 * 出題の「この回」（prd/13 §7.6）。ホームの入口から入ってから、ホームへ戻るまで。
 *
 * - 数えるのは**記録した解答**（1 問 1 回。練習は数えない）。正解は記録の判定が正解の数
 * - `since` はこの回の開始時刻（server の時刻。最初の `/drills/next` が返す `now`）。次の 1 問の取得に渡し、
 *   この回で記録した問題を出さない（§6.4）
 * - 🔒 **クライアント側で持ち、永続化しない**——判定の正典は server の解答履歴にある。棋譜詳細へ移って戻るボタンで
 *   戻っても続くように、画面のコンポーネントの状態ではなく**タブ単位**（sessionStorage）で持つ。
 *   読めない環境（プライベートモードなど）ではメモリだけで持つ（タブを再読み込みすると消える。消えても記録は失われない）
 */

export interface DrillRound {
  /** この回の開始時刻（server の時刻・ISO）。最初の問題を取るまでは null */
  since: string | null;
  /** 記録した解答の数 */
  recorded: number;
  /** そのうち判定が正解の数 */
  correct: number;
}

/** 保存先（テストで差し替える） */
export interface RoundStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const KEY = 'seseraki.drills.round';

function isRound(value: unknown): value is DrillRound {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.since === null || typeof v.since === 'string') &&
    typeof v.recorded === 'number' &&
    typeof v.correct === 'number'
  );
}

/** 「この回」の入れ物。読み書きは storage に写し、描画には同じ参照を返す（`useSyncExternalStore` 用） */
export function createRoundStore(storage: () => RoundStorage | null) {
  let current: DrillRound | null | undefined;
  const listeners = new Set<() => void>();

  function read(): DrillRound | null {
    if (current !== undefined) return current;
    try {
      const raw = storage()?.getItem(KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      current = isRound(parsed) ? parsed : null;
    } catch {
      current = null;
    }
    return current;
  }

  function write(next: DrillRound | null) {
    current = next;
    try {
      const target = storage();
      if (next) target?.setItem(KEY, JSON.stringify(next));
      else target?.removeItem(KEY);
    } catch {
      // 保存できなくてもメモリでは続ける
    }
    for (const listener of listeners) listener();
  }

  return {
    /** 今の回（無ければ null） */
    get: read,
    /** 回を始める（既にあればそのまま） */
    ensure(): DrillRound {
      const round = read();
      if (round) return round;
      const started = { since: null, recorded: 0, correct: 0 };
      write(started);
      return started;
    },
    /** 開始時刻を決める（最初の問題を取ったとき。決まっていれば変えない） */
    startAt(now: string) {
      const round = read();
      if (round && round.since === null) write({ ...round, since: now });
    },
    /** 記録した解答を 1 つ数える */
    record(verdict: 'correct' | 'close' | 'wrong') {
      const round = read() ?? { since: null, recorded: 0, correct: 0 };
      write({
        ...round,
        recorded: round.recorded + 1,
        correct: round.correct + (verdict === 'correct' ? 1 : 0),
      });
    },
    /** 回を終える（ホームに戻ったとき） */
    end() {
      if (read() !== null) write(null);
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** このタブの「この回」 */
export const drillRound = createRoundStore(() => {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
});

/** 画面上部の経過（prd/13 §7.6）。「この回 N 問中 M 問正解」 */
export function roundText(round: DrillRound | null): string {
  const recorded = round?.recorded ?? 0;
  const correct = round?.correct ?? 0;
  return `この回 ${recorded} 問中 ${correct} 問正解`;
}
