/**
 * エンジンの読み込み（評価関数のダウンロード）の表示を出すかどうか。
 *
 * ダウンロード済みの端末では、評価関数は HTTP キャッシュから読まれてすぐ 100% になる。
 * そのたびに進捗が一瞬だけ出るのを避けるため、**始めてから一定時間たっても受信し終えていないときだけ**出す。
 * 受信し終えたら（エンジンの起動を待つ間も）消す。
 */
import { useEffect, useState } from 'react';
import type { BrowserAnalysisState } from './store';

/** これより早く受信し終えた読み込みは表示しない（キャッシュからの読み込みはこの範囲に収まる） */
export const DOWNLOAD_NOTICE_DELAY_MS = 1000;

type Download = BrowserAnalysisState['download'];

/** いま（`now`）表示するか */
export function showsDownloadNotice(download: Download, now: number): boolean {
  if (!download) return false;
  if (download.total > 0 && download.loaded >= download.total) return false;
  return now - download.startedAt >= DOWNLOAD_NOTICE_DELAY_MS;
}

/** 表示するか（待ち時間を過ぎたら描き直す） */
export function useDownloadNoticeVisible(download: Download): boolean {
  const [now, setNow] = useState(() => Date.now());
  const startedAt = download?.startedAt ?? null;
  useEffect(() => {
    if (startedAt === null) return;
    const wait = startedAt + DOWNLOAD_NOTICE_DELAY_MS - Date.now();
    if (wait <= 0) {
      setNow(Date.now());
      return;
    }
    const timer = setTimeout(() => setNow(Date.now()), wait);
    return () => clearTimeout(timer);
  }, [startedAt]);
  return showsDownloadNotice(download, Math.max(now, Date.now()));
}
