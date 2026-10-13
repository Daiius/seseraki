# shellcheck shell=bash
# build.sh / fetch-eval.sh が source する共通部分。単体では実行しない。

PKG_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
UPSTREAM_FILE=$PKG_DIR/UPSTREAM
CACHE_DIR=$PKG_DIR/.cache
# 配信物の根。web がこの下をそのまま静的ファイルとして配る。
DIST_DIR=$PKG_DIR/dist/engine
# 直近のビルドの記録（どの上流・どのイメージで作り、dist のどこへ置いたか）。
STAMP_FILE=$CACHE_DIR/engine.stamp

log() { printf '%s\n' "$*"; }
die() {
  printf 'エラー: %s\n' "$*" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "$1 が見つかりません。$2"
}

# KEY=VALUE のファイルを読み、<接頭辞><KEY> という変数に入れる。
# source しない（値をシェルに解釈させない）。値は JSON と引数にそのまま書ける文字だけを許す。
load_kv() {
  local file=$1 prefix=$2 line key value
  [ -f "$file" ] || die "$file がありません。"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in '' | '#'*) continue ;; esac
    key=${line%%=*}
    value=${line#*=}
    [[ "$line" == *=* && "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || die "$file の行を読めません: $line"
    [[ "$value" =~ ^[A-Za-z0-9._:/+-]+$ ]] || die "$file の $key の値に使えない文字があります: $value"
    printf -v "${prefix}${key}" '%s' "$value"
  done <"$file"
}

load_upstream() {
  load_kv "$UPSTREAM_FILE" UP_
  local key name
  for key in YANEURAOU_REPO YANEURAOU_SHA EMSDK_IMAGE BUILD_TARGET EXPORT_NAME FV_SCALE \
    EVAL_NAME EVAL_URL EVAL_ENTRY EVAL_BYTES EVAL_SHA256 EVAL_EXTRACT_IMAGE; do
    name=UP_$key
    [ -n "${!name:-}" ] || die "UPSTREAM に $key がありません。"
  done
  [[ "$UP_YANEURAOU_SHA" =~ ^[0-9a-f]{40}$ ]] || die "UPSTREAM の YANEURAOU_SHA は 40 桁のコミット SHA にします。"
  [[ "$UP_EVAL_SHA256" =~ ^[0-9a-f]{64}$ ]] || die "UPSTREAM の EVAL_SHA256 は 64 桁の sha256 にします。"
  [[ "$UP_EVAL_BYTES" =~ ^[1-9][0-9]*$ ]] || die "UPSTREAM の EVAL_BYTES は正の整数にします。"
  [[ "$UP_FV_SCALE" =~ ^[1-9][0-9]*$ ]] || die "UPSTREAM の FV_SCALE は正の整数にします。"

  # グルーが .worker.js と .wasm の名前を固定で持つので、ファイル名は上流のまま使う。
  ENGINE_JS=yaneuraou.$UP_BUILD_TARGET.js
  ENGINE_WORKER=yaneuraou.$UP_BUILD_TARGET.worker.js
  ENGINE_WASM=yaneuraou.$UP_BUILD_TARGET.wasm
  EVAL_FILE=eval/nn-${UP_EVAL_SHA256:0:16}.bin
}

sha256_of() {
  local out
  out=$(sha256sum -- "$1") || die "sha256 を計算できません: $1"
  printf '%s' "${out%% *}"
}

# エンジンの内容ハッシュ（3 ファイルの sha256 から作る 16 桁）。配信ディレクトリの名前に使う。
engine_content_hash() {
  local dir=$1 out
  out=$(printf '%s  %s\n' \
    "$(sha256_of "$dir/$ENGINE_JS")" "$ENGINE_JS" \
    "$(sha256_of "$dir/$ENGINE_WORKER")" "$ENGINE_WORKER" \
    "$(sha256_of "$dir/$ENGINE_WASM")" "$ENGINE_WASM" | sha256sum) || die "内容ハッシュを計算できません: $dir"
  printf '%s' "${out:0:16}"
}

engine_files_present() {
  local dir=$1
  [ -s "$dir/$ENGINE_JS" ] && [ -s "$dir/$ENGINE_WORKER" ] && [ -s "$dir/$ENGINE_WASM" ]
}

# 直近のビルドの記録を ST_* に読む。無ければ 1 を返す。
load_stamp() {
  ST_YANEURAOU_SHA='' ST_EMSDK_IMAGE='' ST_BUILD_TARGET='' ST_ENGINE_DIR=''
  [ -f "$STAMP_FILE" ] || return 1
  load_kv "$STAMP_FILE" ST_
  [[ "$ST_ENGINE_DIR" =~ ^[0-9a-f]{16}$ ]]
}

# dist のエンジンが、UPSTREAM の今の値で作ったものとして揃っているか。
engine_up_to_date() {
  load_stamp || return 1
  [ "$ST_YANEURAOU_SHA" = "$UP_YANEURAOU_SHA" ] || return 1
  [ "$ST_EMSDK_IMAGE" = "$UP_EMSDK_IMAGE" ] || return 1
  [ "$ST_BUILD_TARGET" = "$UP_BUILD_TARGET" ] || return 1
  engine_files_present "$DIST_DIR/$ST_ENGINE_DIR" || return 1
  [ "$(engine_content_hash "$DIST_DIR/$ST_ENGINE_DIR")" = "$ST_ENGINE_DIR" ]
}

# dist の評価関数が UPSTREAM の sha256 と一致しているか。
eval_up_to_date() {
  [ -f "$DIST_DIR/$EVAL_FILE" ] || return 1
  [ "$(sha256_of "$DIST_DIR/$EVAL_FILE")" = "$UP_EVAL_SHA256" ]
}

docker_usable() {
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1
}

require_docker() {
  need_cmd docker "Docker を入れてから流し直してください。"
  docker info >/dev/null 2>&1 || die "docker に接続できません（デーモンが動いているか・権限があるかを確かめてください）。"
}

require_image() {
  docker image inspect "$1" >/dev/null 2>&1 ||
    die "Docker イメージ $1 が手元にありません。先に docker pull $1 を流してください。"
}

docker_is_rootless() {
  docker info --format '{{.SecurityOptions}}' 2>/dev/null | grep -q rootless
}

# manifest が指さなくなった配信物（以前のビルド・以前の評価関数・置きかけの残り）を消す。
# manifest を切り替えた後にだけ呼ぶ。先に消すと、途中で失敗したときに古い manifest が無いファイルを指す。
prune_dist() {
  local keep_dir=$1 keep_eval=$DIST_DIR/$EVAL_FILE old name
  for old in "$DIST_DIR"/*/; do
    [ -d "$old" ] || continue
    name=$(basename "$old")
    if [[ "$name" =~ ^[0-9a-f]{16}(\.tmp)?$ ]] && [ "$name" != "$keep_dir" ]; then
      rm -rf -- "${DIST_DIR:?}/$name"
      log "以前のビルドを消しました: $name"
    fi
  done
  for old in "$DIST_DIR"/eval/nn-*.bin "$DIST_DIR"/eval/nn-*.bin.tmp; do
    [ -f "$old" ] || continue
    if [ "$old" != "$keep_eval" ]; then
      rm -f -- "$old"
      log "以前の評価関数を消しました: $(basename "$old")"
    fi
  done
}

# エンジンと評価関数が両方揃っていれば dist/engine/manifest.json を書き、その後で以前の配信物を消す。
# 片方でも UPSTREAM の今の値と合っていなければ manifest を置かない（ファイルは消さない）。
write_manifest() {
  local manifest=$DIST_DIR/manifest.json
  if ! engine_up_to_date; then
    rm -f "$manifest"
    log "manifest: エンジンがまだ無いので書きません（pnpm --filter engine-wasm engine:build）。"
    return 0
  fi
  if ! eval_up_to_date; then
    rm -f "$manifest"
    log "manifest: 評価関数がまだ無いので書きません（pnpm --filter engine-wasm engine:eval）。"
    return 0
  fi

  local dir=$DIST_DIR/$ST_ENGINE_DIR js_sha worker_sha wasm_sha eval_bytes build_id
  js_sha=$(sha256_of "$dir/$ENGINE_JS")
  worker_sha=$(sha256_of "$dir/$ENGINE_WORKER")
  wasm_sha=$(sha256_of "$dir/$ENGINE_WASM")
  eval_bytes=$(wc -c <"$DIST_DIR/$EVAL_FILE")
  eval_bytes=${eval_bytes//[[:space:]]/}
  # 来歴に記録する短い識別子。上流のコミットと、実際にできた wasm の両方で決まる。
  build_id=${UP_YANEURAOU_SHA:0:8}-${wasm_sha:0:12}

  # 値は load_kv が文字種を絞ったものと 16 進だけなので、エスケープは要らない。
  # 失敗は明示的に止める（呼び出し側が if の中で呼んでも、書けなかった manifest のまま先へ進んで消さない）。
  cat >"$manifest.tmp" <<EOF || die "manifest を書けません: $manifest.tmp"
{
  "engine": {
    "buildId": "$build_id",
    "upstreamSha": "$UP_YANEURAOU_SHA",
    "emsdk": "$UP_EMSDK_IMAGE",
    "target": "$UP_BUILD_TARGET",
    "exportName": "$UP_EXPORT_NAME",
    "dir": "$ST_ENGINE_DIR",
    "files": {
      "js": "$ENGINE_JS",
      "worker": "$ENGINE_WORKER",
      "wasm": "$ENGINE_WASM"
    },
    "sha256": {
      "js": "$js_sha",
      "worker": "$worker_sha",
      "wasm": "$wasm_sha"
    }
  },
  "eval": {
    "name": "$UP_EVAL_NAME",
    "file": "$EVAL_FILE",
    "bytes": $eval_bytes,
    "sha256": "$UP_EVAL_SHA256"
  },
  "fvScale": $UP_FV_SCALE
}
EOF
  mv -f "$manifest.tmp" "$manifest" || die "manifest を切り替えられません: $manifest"
  log "manifest: $manifest を書きました（buildId $build_id）。"
  prune_dist "$ST_ENGINE_DIR"
}
