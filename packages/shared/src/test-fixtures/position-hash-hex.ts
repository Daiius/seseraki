// テスト専用（index.ts からは export しない）。
import { positionHash } from '../position-hash';

/** 局面キーのハッシュを 16 進 16 桁で書く（既知の値と照らすため） */
export function positionHashHex(key: string): string {
  return [...positionHash(key)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
