import { describe, expect, it } from 'vitest';
import { DOWNLOAD_NOTICE_DELAY_MS, showsDownloadNotice } from './downloadNotice';

describe('showsDownloadNotice', () => {
  const startedAt = 10_000;

  it('読み込んでいなければ出さない', () => {
    expect(showsDownloadNotice(null, startedAt + 5000)).toBe(false);
  });

  it('始めてすぐは出さない（キャッシュからの読み込みで一瞬だけ出るのを避ける）', () => {
    expect(
      showsDownloadNotice({ loaded: 0, total: 100, startedAt }, startedAt + DOWNLOAD_NOTICE_DELAY_MS - 1),
    ).toBe(false);
  });

  it('待ち時間を過ぎても受信中なら出す', () => {
    expect(
      showsDownloadNotice({ loaded: 30, total: 100, startedAt }, startedAt + DOWNLOAD_NOTICE_DELAY_MS),
    ).toBe(true);
  });

  it('受信し終えたら出さない（エンジンの起動を待つ間も）', () => {
    expect(showsDownloadNotice({ loaded: 100, total: 100, startedAt }, startedAt + 5000)).toBe(false);
  });
});
