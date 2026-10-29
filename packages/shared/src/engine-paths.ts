// ブラウザ解析のエンジンの配信物のパス（prd/14-multi-user.md §5.5）。
//
// 🔒 **何も import しない。** web の Vite プラグイン（`packages/web/engine-plugin/serving.ts`）が相対パスで読む——
// Vite の設定の読み込みは `shared` をバンドルせず外に出し、node が `src/index.ts`（拡張子なしの import を持つ）を
// 読めずに落ちるため。相対パスならこのファイルだけが設定のバンドルに入る。

/**
 * 配信物を置く URL のパス（web と同じオリジンの `/engine/`）。
 * web の読み込み（`enginePaths.ts`）と dev / preview の配信（`engine-plugin/serving.ts`）がここを読む
 */
export const ENGINE_BASE_PATH = '/engine/';

/**
 * 配信物のパスの 1 階層ぶんの名前に許す形（正規表現の本体。`^` `$` は付けない）。
 * 区切り・親ディレクトリへの参照・先頭のドットを通さない。manifest の値をそのまま URL やパスに継ぐので、外へ出る値をここで弾く。
 * 🔒 **ここが唯一の定義**——manifest の検証（`engine-manifest.ts`）・dev の配信（`engine-plugin/serving.ts`）・エンジンのホスト
 * （`engine-host.js`。classic の Worker なので import できず、初期化の本文で受け取る）が同じ形を使う
 */
export const ENGINE_PATH_SEGMENT_PATTERN = '[A-Za-z0-9_-][A-Za-z0-9._-]*';

const segmentRegex = new RegExp(`^${ENGINE_PATH_SEGMENT_PATTERN}$`);

/** 1 階層ぶんの名前として使えるか（{@link ENGINE_PATH_SEGMENT_PATTERN}） */
export function isEnginePathSegment(segment: string): boolean {
  return segmentRegex.test(segment);
}
