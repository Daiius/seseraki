import type { SwarsGameData } from './csa-to-kif.js';
import { parseHistoryPage, parseGamePage } from './parse.js';

const SWARS_BASE = process.env.SWARS_BASE_URL ?? '';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36';
const REQUEST_INTERVAL_MS = 3000;

let lastRequestTime = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function swarsGet(
  path: string,
  cookie?: string,
): Promise<string> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < REQUEST_INTERVAL_MS) {
    await sleep(REQUEST_INTERVAL_MS - elapsed);
  }
  lastRequestTime = Date.now();

  const headers: Record<string, string> = { 'User-Agent': USER_AGENT };
  if (cookie) {
    headers['Cookie'] = `_web_session=${cookie}`;
  }

  const res = await fetch(`${SWARS_BASE}${path}`, { headers });
  if (res.status === 401 || res.status === 302) {
    throw new Error('Cookie expired, re-login required');
  }
  if (!res.ok) {
    throw new Error(`swars returned ${res.status} for ${path}`);
  }
  return res.text();
}

export async function fetchHistoryKeys(
  userId: string,
  gtype: string,
  page: number,
  cookie: string,
): Promise<string[]> {
  const gtypeParam = gtype ? `&gtype=${gtype}` : '';
  const html = await swarsGet(
    `/games/history?user_id=${userId}&locale=ja&page=${page}${gtypeParam}`,
    cookie,
  );
  return parseHistoryPage(html);
}

export async function fetchGameData(
  gameKey: string,
): Promise<SwarsGameData> {
  const html = await swarsGet(`/games/${gameKey}`);
  return parseGamePage(html);
}
