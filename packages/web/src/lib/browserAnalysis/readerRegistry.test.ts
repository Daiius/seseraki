import { describe, expect, it } from 'vitest';
import { unavailableReasonOf } from './readerRegistry';

describe('unavailableReasonOf', () => {
  it('同意の前・解析できない・エンジンが無い・止まっている、は頼めない', () => {
    expect(unavailableReasonOf('needs-consent')).toBe('needs-consent');
    expect(unavailableReasonOf('unsupported')).toBe('unsupported');
    expect(unavailableReasonOf('no-engine')).toBe('no-engine');
    expect(unavailableReasonOf('error')).toBe('error');
  });
  it('起動の途中・待機中・読み込み中・解析中は、待てば頼める', () => {
    for (const phase of ['off', 'idle', 'loading', 'analyzing'] as const) {
      expect(unavailableReasonOf(phase)).toBeNull();
    }
  });
});
