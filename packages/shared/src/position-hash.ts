/**
 * 局面キーの 64 ビットハッシュ（prd/14 §6.3・prd/10 §5.1）。
 *
 * 局面索引（`kifu_positions`）は SFEN 文字列そのものではなく、**このハッシュ（8 バイト）で索引を引き、
 * 引いた後に盤のバイト列・持ち駒・手番で照合する**。照合があるので、衝突しても無関係な棋譜は混ざらない
 * （衝突は「候補が 1 行増える」だけ）。文字列は盤と持ち駒から作り直せるので保存しない。
 *
 * - 関数は **FNV-1a 64**（入力は UTF-8 のバイト列、出力はビッグエンディアンの 8 バイト）
 * - 入力は局面キーの文字列（`positionSfen` / `sideSfen` が返すもの）
 * - ⚠ **環境非依存**（`lib: esnext` / `types: []`）。node の `crypto` も Web Crypto も
 *   `TextEncoder` も使わず、純粋な演算だけで書く。**ブラウザでも同じ値を出すため**
 *
 * 🔴 **この関数（アルゴリズム・入力の文字列・バイト順）を変えたら、局面索引の全件の作り直しが要る**
 * （`rebuild-positions`）。DB に入っている値と検索時に計算する値が食い違い、**局面検索が黙って空になる**。
 * 変えないことをテストの既知の値で固定している（`position-hash.test.ts`）。
 */

/** FNV-1a 64 の初期値 `0xcbf29ce484222325` を上位・下位 32 ビットに分けたもの */
const OFFSET_HI = 0xcbf29ce4;
const OFFSET_LO = 0x84222325;

/** FNV 64 の素数 `0x100000001b3 = 2^40 + 0x1b3` の下位部分 */
const PRIME_LO = 0x1b3;

const TWO_32 = 0x1_0000_0000;

/** 文字列を UTF-8 のバイト列にして 1 バイトずつ渡す（`TextEncoder` は環境依存なので使わない） */
function forEachUtf8Byte(text: string, fn: (byte: number) => void): void {
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) {
      fn(cp);
    } else if (cp < 0x800) {
      fn(0xc0 | (cp >> 6));
      fn(0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      fn(0xe0 | (cp >> 12));
      fn(0x80 | ((cp >> 6) & 0x3f));
      fn(0x80 | (cp & 0x3f));
    } else {
      fn(0xf0 | (cp >> 18));
      fn(0x80 | ((cp >> 12) & 0x3f));
      fn(0x80 | ((cp >> 6) & 0x3f));
      fn(0x80 | (cp & 0x3f));
    }
  }
}

/**
 * 局面キー文字列の 64 ビットハッシュ（FNV-1a 64・ビッグエンディアン 8 バイト）。
 *
 * BigInt でも書けるが、索引の再構築は全棋譜 × 全局面 × 3 本ぶん回るので、
 * **32 ビット 2 本に分けて**計算する（値は BigInt 版と一致する。テストで照合している）。
 */
export function positionHash(key: string): Uint8Array {
  let hi = OFFSET_HI;
  let lo = OFFSET_LO;
  forEachUtf8Byte(key, (byte) => {
    lo = (lo ^ byte) >>> 0;
    // h * (2^40 + 0x1b3) mod 2^64
    //   = h * 0x1b3 + (h << 40)
    // 下位: lo * 0x1b3 は 2^41 未満なので double で正確に表せる
    const loProduct = lo * PRIME_LO;
    const carry = Math.floor(loProduct / TWO_32);
    // 上位: hi * 0x1b3 の下位 32 ビット + 下位からの繰り上がり + (lo << 8)（h << 40 の上位側）
    hi = (Math.imul(hi, PRIME_LO) + carry + ((lo << 8) >>> 0)) >>> 0;
    lo = loProduct >>> 0;
  });
  const out = new Uint8Array(8);
  out[0] = hi >>> 24;
  out[1] = (hi >>> 16) & 0xff;
  out[2] = (hi >>> 8) & 0xff;
  out[3] = hi & 0xff;
  out[4] = lo >>> 24;
  out[5] = (lo >>> 16) & 0xff;
  out[6] = (lo >>> 8) & 0xff;
  out[7] = lo & 0xff;
  return out;
}

/** ハッシュを 16 進 16 桁で書く（テスト・調査用） */
export function positionHashHex(key: string): string {
  return [...positionHash(key)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
