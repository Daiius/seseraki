import type { SwarsGameData } from './csa-to-kif.js';

// 履歴ページ HTML から対局キーを抽出
// 対局キー形式: {先手}-{後手}-{YYYYMMDD_HHMMSS}
const GAME_KEY_RE = /\/games\/([\w]+-[\w]+-\d{8}_\d{6})/g;

export function parseHistoryPage(html: string): string[] {
  const keys: string[] = [];
  let match;
  while ((match = GAME_KEY_RE.exec(html)) !== null) {
    if (!keys.includes(match[1])) {
      keys.push(match[1]);
    }
  }
  return keys;
}

// 棋譜ページ HTML から data-react-props 内の JSON を抽出
const REACT_PROPS_RE = /data-react-props="([^"]*)"/;

const KNOWN_GAME_KEYS = new Set([
  'name', 'sente', 'gote', 'sente_dan', 'gote_dan', 'result', 'gtype',
  'handicap', 'moves', 'opponent_type', 'init_pos_type', 'sente_avatar',
  'gote_avatar', 'init_sfen_position', 'sente_time_limit', 'gote_time_limit',
  'sente_byoyomi', 'gote_byoyomi',
]);

export function parseGamePage(html: string): SwarsGameData {
  const match = REACT_PROPS_RE.exec(html);
  if (!match) {
    throw new Error('data-react-props not found in game page');
  }

  // HTML エンティティのデコード
  const decoded = match[1]
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  const json = JSON.parse(decoded);

  const game = json.gameHash ?? json.game_hash ?? json;
  if (!game.moves || !game.sente) {
    throw new Error('Invalid game data structure');
  }

  // 未知のフィールドを検出
  for (const key of Object.keys(game)) {
    if (!KNOWN_GAME_KEYS.has(key)) {
      console.log(`[swars] Unknown field: ${key} = ${JSON.stringify(game[key])}`);
    }
  }

  return game as SwarsGameData;
}
