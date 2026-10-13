#!/usr/bin/env bash
# やねうら王の WebAssembly ビルドを作り、dist/engine/<内容ハッシュ>/ に集める。
# 上流を UPSTREAM の SHA で取得し、上流のビルド手順（script/wasm_build.js）をそのまま Docker の中で流す。
# パッチは当てない。
set -euo pipefail

# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  cat <<'EOF'
使い方: build.sh [--check] [--force]

  --check   何をするかと現状を表示して終わる（何も変えない）
  --force   成果物が揃っていても作り直す

上流のコミット・Emscripten のイメージ・ビルド対象は UPSTREAM から読む。
EOF
}

CHECK=0
FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1 ;;
    --force) FORCE=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "知らない引数です: $1"
      ;;
  esac
  shift
done

need_cmd git "上流の取得に使います。"
need_cmd sha256sum "成果物のハッシュの計算に使います。"
load_upstream

SRC_DIR=$CACHE_DIR/YaneuraOu
OUT_DIR=$SRC_DIR/build/wasm/$UP_BUILD_TARGET/lib

UP_TO_DATE=0
if engine_up_to_date; then UP_TO_DATE=1; fi

log "上流:         $UP_YANEURAOU_REPO @ $UP_YANEURAOU_SHA"
log "イメージ:     $UP_EMSDK_IMAGE"
log "ビルド対象:   $UP_BUILD_TARGET"
log "作業場所:     $SRC_DIR"
log "置き場:       $DIST_DIR/<内容ハッシュ>/"
if [ "$UP_TO_DATE" -eq 1 ]; then
  log "現状:         ビルド済み（$DIST_DIR/$ST_ENGINE_DIR）"
else
  log "現状:         未ビルド、または UPSTREAM の値と合っていない"
fi

if [ "$CHECK" -eq 1 ]; then
  if docker_usable; then
    if docker image inspect "$UP_EMSDK_IMAGE" >/dev/null 2>&1; then
      log "docker:       使える・イメージあり"
    else
      log "docker:       使える・イメージなし（docker pull $UP_EMSDK_IMAGE が要る）"
    fi
  else
    log "docker:       使えない（入っていないか、接続できない）"
  fi
  if [ "$UP_TO_DATE" -eq 1 ] && [ "$FORCE" -eq 0 ]; then
    log "実行したら:   何も作り直さない（manifest だけ書き直す）"
  else
    log "実行したら:   上流を取得 → Docker でビルド → dist へ集める → manifest を書く"
  fi
  exit 0
fi

if [ "$UP_TO_DATE" -eq 1 ] && [ "$FORCE" -eq 0 ]; then
  log "ビルド済みなので作り直しません（作り直すなら --force）。"
  write_manifest
  exit 0
fi

require_docker
require_image "$UP_EMSDK_IMAGE"

# --- 上流を固定の SHA で取得する ---
mkdir -p "$SRC_DIR"
if [ ! -d "$SRC_DIR/.git" ]; then
  git init -q "$SRC_DIR"
fi
if git -C "$SRC_DIR" remote get-url origin >/dev/null 2>&1; then
  git -C "$SRC_DIR" remote set-url origin "$UP_YANEURAOU_REPO"
else
  git -C "$SRC_DIR" remote add origin "$UP_YANEURAOU_REPO"
fi
if ! git -C "$SRC_DIR" cat-file -e "$UP_YANEURAOU_SHA^{commit}" 2>/dev/null; then
  log "上流を取得します..."
  git -C "$SRC_DIR" fetch -q --depth 1 origin "$UP_YANEURAOU_SHA"
fi
# この先の reset / clean が、外側のリポジトリではなく作業場所の中だけに効くことを確かめる。
[ "$(git -C "$SRC_DIR" rev-parse --show-toplevel)" = "$SRC_DIR" ] ||
  die "$SRC_DIR が独立した git の作業ツリーになっていません（.cache を消してから流し直してください）。"
# 前回の生成物と手元の変更を残さない（上流のコミットそのままをビルドする）。
git -C "$SRC_DIR" -c advice.detachedHead=false checkout -q --force --detach "$UP_YANEURAOU_SHA"
git -C "$SRC_DIR" reset -q --hard "$UP_YANEURAOU_SHA"
git -C "$SRC_DIR" clean -q -fdx
[ "$(git -C "$SRC_DIR" rev-parse HEAD)" = "$UP_YANEURAOU_SHA" ] ||
  die "取得した上流のコミットが UPSTREAM の値と一致しません。"

# --- Docker でビルドする ---
docker_args=(run --rm -v "$SRC_DIR:/src" -w /src)
# rootless の docker ではコンテナの root がホストの自分に対応するので、-u を付けると逆に書けなくなる。
# root で動く docker では、生成物が root の持ち物にならないよう自分の uid で動かす。
if ! docker_is_rootless; then
  docker_args+=(-u "$(id -u):$(id -g)")
fi
log "ビルドします（数分かかります）..."
docker "${docker_args[@]}" "$UP_EMSDK_IMAGE" node script/wasm_build.js "$UP_BUILD_TARGET"

engine_files_present "$OUT_DIR" ||
  die "ビルドの成果物が見つかりません: $OUT_DIR/{$ENGINE_JS,$ENGINE_WORKER,$ENGINE_WASM}"
grep -q -- "$UP_EXPORT_NAME" "$OUT_DIR/$ENGINE_JS" ||
  die "グルーに $UP_EXPORT_NAME が見つかりません（UPSTREAM の EXPORT_NAME と上流のビルド対象が合っていない）。"

# --- dist に集める ---
ENGINE_DIR=$(engine_content_hash "$OUT_DIR")
[[ "$ENGINE_DIR" =~ ^[0-9a-f]{16}$ ]] || die "内容ハッシュを計算できませんでした。"

mkdir -p "$DIST_DIR"
# 配信物の形を「今のビルドだけ」に保つ。以前のビルドのディレクトリ（16 桁の 16 進）は消す。
for old in "$DIST_DIR"/*/; do
  [ -d "$old" ] || continue
  name=$(basename "$old")
  if [[ "$name" =~ ^[0-9a-f]{16}$ ]] && [ "$name" != "$ENGINE_DIR" ]; then
    rm -rf -- "${DIST_DIR:?}/$name"
    log "以前のビルドを消しました: $name"
  fi
done

rm -rf -- "${DIST_DIR:?}/$ENGINE_DIR.tmp"
mkdir -p "$DIST_DIR/$ENGINE_DIR.tmp"
for f in "$ENGINE_JS" "$ENGINE_WORKER" "$ENGINE_WASM"; do
  install -m 644 "$OUT_DIR/$f" "$DIST_DIR/$ENGINE_DIR.tmp/$f"
done
rm -rf -- "${DIST_DIR:?}/$ENGINE_DIR"
mv "$DIST_DIR/$ENGINE_DIR.tmp" "$DIST_DIR/$ENGINE_DIR"

mkdir -p "$CACHE_DIR"
printf '%s\n' \
  "YANEURAOU_SHA=$UP_YANEURAOU_SHA" \
  "EMSDK_IMAGE=$UP_EMSDK_IMAGE" \
  "BUILD_TARGET=$UP_BUILD_TARGET" \
  "ENGINE_DIR=$ENGINE_DIR" >"$STAMP_FILE"

log "エンジンを置きました: $DIST_DIR/$ENGINE_DIR"
write_manifest
