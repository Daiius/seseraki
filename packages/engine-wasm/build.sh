#!/usr/bin/env bash
# やねうら王の WebAssembly ビルドを評価関数の型（EDITION）ごとに作り、dist/engine/<内容ハッシュ>/ に集める。
# 上流を UPSTREAM の SHA で取得し、上流の Makefile を Docker（emsdk）の中でそのまま流す。パッチは当てない。
#
# 上流の script/wasm_build.js には SFNN のビルド対象が無いので、wasm_build.js が使うのと同じ make の行を直接流す:
#   make -j clean tournament COMPILER=em++ TARGET_CPU=WASM PYTHON=python3 YANEURAOU_EDITION=<EDITION>
#        TARGET=<出力先>/yaneuraou.<名前>.js EM_EXPORT_NAME=<公開名> EM_INITIAL_MEMORY_SIZE=<初期メモリ>
set -euo pipefail

# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  cat <<'EOF'
使い方: build.sh [--check] [--force]

  --check   何をするかと現状を表示して終わる（何も変えない）
  --force   成果物が揃っていても作り直す

上流のコミット・Emscripten のイメージ・評価関数の型（EDITION）と公開名は UPSTREAM から読む。
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

log "上流:         $UP_YANEURAOU_REPO @ $UP_YANEURAOU_SHA"
log "イメージ:     $UP_EMSDK_IMAGE"
log "作業場所:     $SRC_DIR"
log "置き場:       $DIST_DIR/<内容ハッシュ>/"

# 作り直すエンジン（EDITION）の一覧。
TO_BUILD=()
for edition in "${ENGINE_EDITIONS[@]}"; do
  name=$(engine_name_of "$edition")
  if engine_up_to_date "$edition"; then
    log "エンジン:     $name（公開名 $(engine_export_of "$edition")）ビルド済み（$DIST_DIR/$ST_ENGINE_DIR）"
    [ "$FORCE" -eq 1 ] && TO_BUILD+=("$edition")
  else
    log "エンジン:     $name（公開名 $(engine_export_of "$edition")）未ビルド、または UPSTREAM の値と合っていない"
    TO_BUILD+=("$edition")
  fi
done

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
  if [ "${#TO_BUILD[@]}" -eq 0 ]; then
    log "実行したら:   何も作り直さない（manifest だけ書き直す）"
  else
    log "実行したら:   上流を取得 → Docker でビルド（$(for e in "${TO_BUILD[@]}"; do printf '%s ' "$(engine_name_of "$e")"; done)）→ dist へ集める → manifest を書く"
  fi
  exit 0
fi

if [ "${#TO_BUILD[@]}" -eq 0 ]; then
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

docker_args=(run --rm -v "$SRC_DIR:/src" -w /src/source)
# rootless の docker ではコンテナの root がホストの自分に対応するので、-u を付けると逆に書けなくなる。
# root で動く docker では、生成物が root の持ち物にならないよう自分の uid で動かす。
if ! docker_is_rootless; then
  docker_args+=(-u "$(id -u):$(id -g)")
fi

mkdir -p "$DIST_DIR" "$CACHE_DIR"
for edition in "${TO_BUILD[@]}"; do
  name=$(engine_name_of "$edition")
  export_name=$(engine_export_of "$edition")
  set_engine_files "$edition"

  # 前回の生成物と手元の変更を残さない（上流のコミットそのままをビルドする）。EDITION ごとに clean からやり直す。
  git -C "$SRC_DIR" -c advice.detachedHead=false checkout -q --force --detach "$UP_YANEURAOU_SHA"
  git -C "$SRC_DIR" reset -q --hard "$UP_YANEURAOU_SHA"
  git -C "$SRC_DIR" clean -q -fdx
  [ "$(git -C "$SRC_DIR" rev-parse HEAD)" = "$UP_YANEURAOU_SHA" ] ||
    die "取得した上流のコミットが UPSTREAM の値と一致しません。"

  # 出力先は作業場所の中（git clean で消える場所）。コンテナからは /src/... に見える。
  OUT_REL=build/wasm/$name
  OUT_DIR=$SRC_DIR/$OUT_REL
  mkdir -p "$OUT_DIR"

  log "ビルドします: $name（数分かかります）..."
  docker "${docker_args[@]}" "$UP_EMSDK_IMAGE" sh -c '
    set -e
    exec make -j"$(nproc)" clean tournament COMPILER=em++ TARGET_CPU=WASM PYTHON=python3 \
      YANEURAOU_EDITION="$1" TARGET="$2" EM_EXPORT_NAME="$3" EM_INITIAL_MEMORY_SIZE="$4"
  ' sh "$edition" "/src/$OUT_REL/$ENGINE_JS" "$export_name" "$UP_EM_INITIAL_MEMORY_SIZE"

  engine_files_present "$OUT_DIR" ||
    die "ビルドの成果物が見つかりません: $OUT_DIR/{$ENGINE_JS,$ENGINE_WORKER,$ENGINE_WASM}"
  grep -q -- "$export_name" "$OUT_DIR/$ENGINE_JS" ||
    die "グルーに $export_name が見つかりません（UPSTREAM の EXPORT_NAME が make に渡っていない）。"

  # --- dist に集める ---
  ENGINE_DIR=$(engine_content_hash "$OUT_DIR")
  [[ "$ENGINE_DIR" =~ ^[0-9a-f]{16}$ ]] || die "内容ハッシュを計算できませんでした。"

  # 順序: 新しいものを一時の場所に揃えて確かめる → 置く → 記録 → manifest を切り替える → 以前のものを消す。
  # 以前のビルドは manifest を切り替え終わるまで消さない（write_manifest の最後で消す）。
  # 途中で失敗しても、残っている manifest が指すファイルは残る。
  if engine_files_present "$DIST_DIR/$ENGINE_DIR" &&
    [ "$(engine_content_hash "$DIST_DIR/$ENGINE_DIR")" = "$ENGINE_DIR" ]; then
    # 同じ内容がもう置いてある（--force で同じ物ができた）。置き直さない。
    log "同じ内容のエンジンが置いてあるので、置き直しません: $ENGINE_DIR"
  else
    STAGE_DIR=$DIST_DIR/$ENGINE_DIR.tmp
    rm -rf -- "${STAGE_DIR:?}"
    mkdir -p "$STAGE_DIR"
    for f in "$ENGINE_JS" "$ENGINE_WORKER" "$ENGINE_WASM"; do
      install -m 644 "$OUT_DIR/$f" "$STAGE_DIR/$f"
    done
    [ "$(engine_content_hash "$STAGE_DIR")" = "$ENGINE_DIR" ] ||
      die "集めたファイルの内容がビルドの成果物と一致しません（$STAGE_DIR）。"
    # ここに来るのは、同じ名前の場所が無いか、中身が壊れているときだけ。
    rm -rf -- "${DIST_DIR:?}/$ENGINE_DIR"
    mv "$STAGE_DIR" "$DIST_DIR/$ENGINE_DIR"
  fi

  STAMP_FILE=$(stamp_file_of "$edition")
  printf '%s\n' \
    "YANEURAOU_SHA=$UP_YANEURAOU_SHA" \
    "EMSDK_IMAGE=$UP_EMSDK_IMAGE" \
    "EDITION=$edition" \
    "EXPORT_NAME=$export_name" \
    "EM_INITIAL_MEMORY_SIZE=$UP_EM_INITIAL_MEMORY_SIZE" \
    "ENGINE_DIR=$ENGINE_DIR" >"$STAMP_FILE.tmp"
  mv -f "$STAMP_FILE.tmp" "$STAMP_FILE"

  log "エンジンを置きました: $name → $DIST_DIR/$ENGINE_DIR"
done

# 以前の形（エンジン 1 本の記録）は使わない。
rm -f -- "$CACHE_DIR/engine.stamp"

write_manifest
