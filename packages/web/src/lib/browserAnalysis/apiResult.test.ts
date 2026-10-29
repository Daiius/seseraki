import { describe, expect, it } from 'vitest';
import { classifyFailureStatus, errorReportResultOf } from './apiResult';

describe('classifyFailureStatus', () => {
  it('401 はログイン切れ・403 は続けても直らない拒否', () => {
    expect(classifyFailureStatus(401)).toBe('unauthorized');
    expect(classifyFailureStatus(403)).toBe('fatal');
  });
  it('入力の誤り（4xx）は拒否、5xx と混雑は再試行', () => {
    expect(classifyFailureStatus(400)).toBe('rejected');
    expect(classifyFailureStatus(413)).toBe('rejected');
    expect(classifyFailureStatus(408)).toBe('retry');
    expect(classifyFailureStatus(429)).toBe('retry');
    expect(classifyFailureStatus(500)).toBe('retry');
    expect(classifyFailureStatus(503)).toBe('retry');
  });
});

describe('errorReportResultOf（失敗の報告の 201 の本文）', () => {
  it('applied: true だけが記録済み。破棄（applied: false）は記録済みにしない', () => {
    expect(errorReportResultOf({ ok: true, applied: true })).toBe('recorded');
    expect(errorReportResultOf({ ok: true, applied: false })).toBe('discarded');
    expect(errorReportResultOf({ ok: true })).toBe('discarded');
    expect(errorReportResultOf(null)).toBe('discarded');
  });
});
