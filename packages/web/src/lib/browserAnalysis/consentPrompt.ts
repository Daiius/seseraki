/**
 * 「押した時点で、評価関数のダウンロードの同意を求める」案内の段取り（prd/13 §5.5・prd/12 §2.4・prd/14 §5.10）。
 *
 * 出題の詰将棋の判定（`drillEngine.ts`）と検討盤の局面評価（`studyEval.ts`）が、それぞれ 1 つずつ持つ。
 * - 重ねて聞いたら、同じ答えを待つ（案内は 1 つ）
 * - 🔒 **取り下げ（`signal`）たら待つのをやめて false**——断ったことにはしない。ほかに待つ呼び出しが無ければ案内を閉じる
 *   （次に開いた画面に、頼まれていない同意の案内が残らないように）
 * - 同意なら、評価関数（`nn.bin` の sha256）の同意を端末の設定に足す（全局面解析の同意と同じもの）。
 *   🔒 **sha256 が分からなければ同意として扱わない**（何も保存せずに true を返すと、同意したのに常駐が起動しない）
 *
 * ⚠ 出題の画面・検討盤から読み込むので、エンジンや runner の実装を import しない。
 */
import { getBrowserAnalysisSettings, setBrowserAnalysisSettings, withConsent } from './settings';

export interface ConsentPromptOptions {
  /** 断ったことを覚え、以後は聞かずに false を返す（このタブの間・{@link ConsentPrompt.reset} まで） */
  rememberDecline: boolean;
  /**
   * 案内を出している間に、ほかの案内（棋譜の詳細の「ダウンロードして解析する」・設定のページ）から同意されたかを見る。
   * `agreed()` が true になったら、同意したものとして答える（案内を閉じる）
   */
  settledElsewhere?: {
    subscribe(listener: () => void): () => void;
    agreed(): boolean;
  };
}

export interface ConsentPromptState {
  /** 同意を求めている（画面が案内を出す） */
  asking: boolean;
  /** 断った（`rememberDecline` のときだけ立つ） */
  declined: boolean;
}

export interface ConsentPrompt {
  getState(): ConsentPromptState;
  subscribe(listener: () => void): () => void;
  /**
   * 同意を求め、答えを待つ。既に求めていればその答えを待つ。断ったのを覚えていれば聞かずに false。
   * `signal` が中断されたら待つのをやめて false
   */
  ask(signal?: AbortSignal): Promise<boolean>;
  /** 同意の答え（案内のボタン） */
  answer(agreed: boolean, evalSha256: string | null): void;
  /** テスト用: 状態を最初に戻す */
  reset(): void;
}

const INITIAL: ConsentPromptState = { asking: false, declined: false };

export function createConsentPrompt(options: ConsentPromptOptions): ConsentPrompt {
  let state = INITIAL;
  const listeners = new Set<() => void>();
  /** 同意の答えを待っている呼び出し */
  let waiters: ((agreed: boolean) => void)[] = [];
  /** 案内を出している間だけ、ほかの経路での同意を聞く */
  let offElsewhere: (() => void) | null = null;

  const patch = (next: Partial<ConsentPromptState>) => {
    const merged = { ...state, ...next };
    if (merged.asking === state.asking && merged.declined === state.declined) return;
    const startedAsking = merged.asking && !state.asking;
    state = merged;
    if (!state.asking) {
      offElsewhere?.();
      offElsewhere = null;
    } else if (startedAsking && options.settledElsewhere) {
      const elsewhere = options.settledElsewhere;
      offElsewhere = elsewhere.subscribe(() => {
        if (elsewhere.agreed()) settle(true, false);
      });
    }
    for (const listener of [...listeners]) listener();
  };

  /** 待っている呼び出しすべてに答え、案内を閉じる */
  const settle = (agreed: boolean, declined: boolean) => {
    const resolved = waiters;
    waiters = [];
    patch({ asking: false, ...(options.rememberDecline ? { declined } : {}) });
    for (const resolve of resolved) resolve(agreed);
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ask(signal) {
      if (state.declined || signal?.aborted) return Promise.resolve(false);
      return new Promise((resolve) => {
        const waiter = (agreed: boolean) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(agreed);
        };
        const onAbort = () => {
          if (!waiters.includes(waiter)) return;
          waiters = waiters.filter((w) => w !== waiter);
          if (waiters.length === 0) patch({ asking: false });
          resolve(false);
        };
        waiters.push(waiter);
        signal?.addEventListener('abort', onAbort, { once: true });
        patch({ asking: true });
      });
    },
    answer(agreed, evalSha256) {
      const accepted = agreed && evalSha256 !== null;
      if (accepted) {
        setBrowserAnalysisSettings({
          consentedEvalSha256s: withConsent(getBrowserAnalysisSettings().consentedEvalSha256s, evalSha256),
        });
      }
      settle(accepted, !accepted);
    },
    reset() {
      offElsewhere?.();
      offElsewhere = null;
      state = INITIAL;
      waiters = [];
      listeners.clear();
    },
  };
}
