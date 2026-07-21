// 解析の進捗（server のメモリ上の揮発状態）。
//
// **DB に永続化しない**: (1) チャンク submit が入れば `moveAnalyses` の件数から導出できるため、
// 列を足すと捨てることになる（migration を 2 回打つ）、(2) 数十分の解析中に DB へ UPDATE を
// 繰り返さない、(3) 完了すれば `analysisCompletedAt` が正になる揮発的な情報である。
// server 再起動で消えるが worker の次の報告で復活し、**stale が自動で消える利点**にもなる。
//
// worker は棋譜を 1 件ずつ処理するので**解析中の棋譜は常に高々 1 件**。単一プロセス前提で
// モジュールスコープに持つ流儀は `swars/job-store.ts` と同じ（prd/02 §1 / prd/07）。

export interface AnalysisProgress {
  kifuId: number;
  /** 取得時の解析世代（reanalyze で +1）。どの世代の進捗かを示す */
  revision: number;
  /** 解析済みの局面数 */
  analyzed: number;
  /** 解析対象の局面数（= `usiMoves.length + 1`） */
  total: number;
  /** 最終報告時刻（ISO）。ここが動かなくなること自体が worker のハングの手がかりになる */
  updatedAt: string;
}

let current: AnalysisProgress | null = null;

// clear のたびに進む単調カウンタ。進捗報告は DB を読んでから記録するまでに `await` を挟むため、
// その間に submit / error 報告 / reanalyze / 削除が**完了しきってしまう**（Node は単一スレッドでも
// await の境界で他のハンドラが走る）。古い判定に基づく setProgress がクリアの後に走ると、
// 終わったはずの棋譜が「解析中」として復活し、次の報告が無ければプロセス再起動まで消えない。
// そこで報告側は DB を読む前にこの値を取り、書き込み時に一致を確かめる（compare-and-set）。
let clearToken = 0;

export function getProgress(): AnalysisProgress | null {
  return current;
}

/** 進捗報告を始める前に取り、`setProgress` に渡す（clear と直列化するためのトークン） */
export function getClearToken(): number {
  return clearToken;
}

/**
 * worker からの進捗報告を記録する。
 * `analysisRevision` の世代照合（reanalyze 後に届いた旧解析を弾く）は route 側で DB と
 * 突き合わせて済ませ、ここでは**検証中に clear が挟まっていないこと**だけを見る。
 *
 * @param expectedToken 検証を始める前に取った `getClearToken()` の値
 * @returns 記録したか（clear が挟まっていれば false）
 */
export function setProgress(
  progress: Omit<AnalysisProgress, 'updatedAt'>,
  expectedToken: number,
): boolean {
  if (expectedToken !== clearToken) return false;
  current = { ...progress, updatedAt: new Date().toISOString() };
  return true;
}

/**
 * 解析が終わった棋譜のエントリを落とす（submit 成功 / error 報告 / reanalyze / 削除）。
 * 別の棋譜のエントリに入れ替わっていたら消さないが、**トークンは常に進める**
 * （エントリがまだ無いうちに clear されたケースも弾くため）。検証中の報告を巻き添えで
 * 捨てても、worker は次の局面でまた報告するので数秒で復活する。
 */
export function clearProgress(kifuId: number): void {
  clearToken++;
  if (current?.kifuId === kifuId) current = null;
}

/** テスト用。プロセス状態をリセット */
export function resetProgress(): void {
  current = null;
  clearToken = 0;
}
