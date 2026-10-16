# shellcheck shell=bash
# build.sh / fetch-eval.sh が source する共通部分。単体では実行しない。
#
# 用語:
#   評価関数（eval） UPSTREAM の EVAL_IDS の 1 つ。nn.bin と progress.bin とライセンスの組
#   エンジン        評価関数の EDITION（arch）ごとに 1 本。同じ EDITION の評価関数はエンジンを共有する
#                   エンジンの名前は EDITION から YANEURAOU_ENGINE_ を外して小文字にしたもの

PKG_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
UPSTREAM_FILE=$PKG_DIR/UPSTREAM
CACHE_DIR=$PKG_DIR/.cache
# 配信物の根。web がこの下をそのまま静的ファイルとして配る。
DIST_DIR=$PKG_DIR/dist/engine

# 評価関数の項目（UPSTREAM の EVAL_<ID>_<項目>）。
EVAL_FIELDS=(NAME EDITION EXPORT_NAME FV_SCALE URL ARCHIVE_BYTES ARCHIVE_SHA256
  NN_BYTES NN_SHA256 PROGRESS_BYTES PROGRESS_SHA256 LICENSE LICENSE_FILE SOURCE_URL)

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
# 表示名（_NAME で終わる鍵）だけは日本語を許す（空白・引用符・バックスラッシュは通さない）。
load_kv() {
  local file=$1 prefix=$2 line key value
  [ -f "$file" ] || die "$file がありません。"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in '' | '#'*) continue ;; esac
    key=${line%%=*}
    value=${line#*=}
    [[ "$line" == *=* && "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || die "$file の行を読めません: $line"
    if [[ "$key" == *_NAME && "$key" != *_EXPORT_NAME ]]; then
      case "$value" in
        '' | *[[:space:]]* | *'"'* | *\\* | *[[:cntrl:]]*)
          die "$file の $key の値に使えない文字があります: $value"
          ;;
      esac
    else
      [[ "$value" =~ ^[A-Za-z0-9._:/+-]+$ ]] || die "$file の $key の値に使えない文字があります: $value"
    fi
    printf -v "${prefix}${key}" '%s' "$value"
  done <"$file"
}

# 評価関数の項目の値。例: eval_get tsuyo11mini NN_SHA256
eval_get() {
  local name="UP_EVAL_${1^^}_$2"
  printf '%s' "${!name}"
}

# EDITION からエンジンの名前を作る（成果物のファイル名・作業場所の名前に使う）。
engine_name_of() {
  local rest=${1#YANEURAOU_ENGINE_}
  printf '%s' "${rest,,}"
}

load_upstream() {
  load_kv "$UPSTREAM_FILE" UP_
  local key name id field value
  for key in YANEURAOU_REPO YANEURAOU_SHA EMSDK_IMAGE EM_INITIAL_MEMORY_SIZE EVAL_EXTRACT_IMAGE \
    EVAL_IDS EVAL_DEFAULT; do
    name=UP_$key
    [ -n "${!name:-}" ] || die "UPSTREAM に $key がありません。"
  done
  [[ "$UP_YANEURAOU_SHA" =~ ^[0-9a-f]{40}$ ]] || die "UPSTREAM の YANEURAOU_SHA は 40 桁のコミット SHA にします。"
  [[ "$UP_EM_INITIAL_MEMORY_SIZE" =~ ^[1-9][0-9]*$ ]] || die "UPSTREAM の EM_INITIAL_MEMORY_SIZE は正の整数にします。"

  IFS=: read -r -a EVAL_ID_LIST <<<"$UP_EVAL_IDS"
  [ "${#EVAL_ID_LIST[@]}" -ge 1 ] || die "UPSTREAM の EVAL_IDS が空です。"
  local seen=' ' found_default=0
  for id in "${EVAL_ID_LIST[@]}"; do
    [[ "$id" =~ ^[a-z0-9]+$ ]] || die "UPSTREAM の EVAL_IDS の id は英小文字と数字だけにします: $id"
    [[ "$seen" != *" $id "* ]] || die "UPSTREAM の EVAL_IDS に同じ id が 2 度あります: $id"
    seen="$seen$id "
    [ "$id" = "$UP_EVAL_DEFAULT" ] && found_default=1
    for field in "${EVAL_FIELDS[@]}"; do
      [ -n "$(eval_get "$id" "$field")" ] || die "UPSTREAM に EVAL_${id^^}_$field がありません。"
    done
    for field in ARCHIVE_SHA256 NN_SHA256 PROGRESS_SHA256; do
      [[ "$(eval_get "$id" "$field")" =~ ^[0-9a-f]{64}$ ]] ||
        die "UPSTREAM の EVAL_${id^^}_$field は 64 桁の sha256 にします。"
    done
    for field in ARCHIVE_BYTES NN_BYTES PROGRESS_BYTES FV_SCALE; do
      [[ "$(eval_get "$id" "$field")" =~ ^[1-9][0-9]*$ ]] ||
        die "UPSTREAM の EVAL_${id^^}_$field は正の整数にします。"
    done
    [[ "$(eval_get "$id" EDITION)" =~ ^YANEURAOU_ENGINE_[A-Za-z0-9_]+$ ]] ||
      die "UPSTREAM の EVAL_${id^^}_EDITION は YANEURAOU_ENGINE_ で始めます。"
    [[ "$(eval_get "$id" EXPORT_NAME)" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] ||
      die "UPSTREAM の EVAL_${id^^}_EXPORT_NAME は識別子にします。"
    value=$(eval_get "$id" LICENSE_FILE)
    [[ "$value" =~ ^[A-Za-z0-9_-][A-Za-z0-9._-]*(/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$ ]] ||
      die "UPSTREAM の EVAL_${id^^}_LICENSE_FILE はこのパッケージからの相対パスにします。"
    [ -f "$PKG_DIR/$value" ] || die "評価関数の許諾文がありません: $PKG_DIR/$value"
    for field in URL SOURCE_URL; do
      [[ "$(eval_get "$id" "$field")" == https://* ]] || die "UPSTREAM の EVAL_${id^^}_$field は https にします。"
    done
  done
  [ "$found_default" -eq 1 ] || die "UPSTREAM の EVAL_DEFAULT（$UP_EVAL_DEFAULT）が EVAL_IDS にありません。"

  # エンジン（EDITION ごとに 1 本）の一覧。同じ EDITION の評価関数は公開名も同じでないといけない。
  ENGINE_EDITIONS=()
  local edition export_name other
  for id in "${EVAL_ID_LIST[@]}"; do
    edition=$(eval_get "$id" EDITION)
    export_name=$(eval_get "$id" EXPORT_NAME)
    local known=0
    for other in "${ENGINE_EDITIONS[@]}"; do
      [ "$other" = "$edition" ] && known=1
    done
    if [ "$known" -eq 0 ]; then
      ENGINE_EDITIONS+=("$edition")
      printf -v "ENGINE_EXPORT_$(engine_name_of "$edition")" '%s' "$export_name"
    else
      name=ENGINE_EXPORT_$(engine_name_of "$edition")
      [ "${!name}" = "$export_name" ] ||
        die "EDITION が同じ評価関数で EXPORT_NAME が違います: $edition（${!name} と $export_name）"
    fi
  done
}

# エンジンの公開名（EDITION から）。
engine_export_of() {
  local name="ENGINE_EXPORT_$(engine_name_of "$1")"
  printf '%s' "${!name}"
}

# エンジンのファイル名を ENGINE_JS / ENGINE_WORKER / ENGINE_WASM に入れる。
# グルーが .worker.js と .wasm の名前を固定で持つので、ディレクトリ名に内容ハッシュを入れ、ファイル名は変えない。
set_engine_files() {
  local name
  name=$(engine_name_of "$1")
  ENGINE_JS=yaneuraou.$name.js
  ENGINE_WORKER=yaneuraou.$name.worker.js
  ENGINE_WASM=yaneuraou.$name.wasm
}

# 評価関数のファイルの置き場（dist/engine からの相対・内容ハッシュ入り）。
nn_file_of() { printf 'eval/nn-%s.bin' "$(eval_get "$1" NN_SHA256 | cut -c1-16)"; }
progress_file_of() { printf 'eval/progress-%s.bin' "$(eval_get "$1" PROGRESS_SHA256 | cut -c1-16)"; }
license_file_of() {
  local sha
  sha=$(sha256_of "$PKG_DIR/$(eval_get "$1" LICENSE_FILE)")
  printf 'eval/license-%s.txt' "${sha:0:16}"
}

sha256_of() {
  local out
  out=$(sha256sum -- "$1") || die "sha256 を計算できません: $1"
  printf '%s' "${out%% *}"
}

bytes_of() {
  local bytes
  bytes=$(wc -c <"$1") || die "大きさを読めません: $1"
  printf '%s' "${bytes//[[:space:]]/}"
}

# エンジンの内容ハッシュ（3 ファイルの sha256 から作る 16 桁）。配信ディレクトリの名前に使う。
# 先に set_engine_files で名前を決めておく。
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

# エンジンごとの直近のビルドの記録（どの上流・どのイメージで作り、dist のどこへ置いたか）。
stamp_file_of() { printf '%s/engine-%s.stamp' "$CACHE_DIR" "$(engine_name_of "$1")"; }

# 直近のビルドの記録を ST_* に読む。無ければ 1 を返す。
load_stamp() {
  local file
  file=$(stamp_file_of "$1")
  ST_YANEURAOU_SHA='' ST_EMSDK_IMAGE='' ST_EDITION='' ST_EXPORT_NAME='' ST_EM_INITIAL_MEMORY_SIZE='' ST_ENGINE_DIR=''
  [ -f "$file" ] || return 1
  load_kv "$file" ST_
  [[ "$ST_ENGINE_DIR" =~ ^[0-9a-f]{16}$ ]]
}

# dist のエンジン（EDITION）が、UPSTREAM の今の値で作ったものとして揃っているか。
# 揃っていれば ST_ENGINE_DIR がその置き場を指す。
engine_up_to_date() {
  local edition=$1
  set_engine_files "$edition"
  load_stamp "$edition" || return 1
  [ "$ST_YANEURAOU_SHA" = "$UP_YANEURAOU_SHA" ] || return 1
  [ "$ST_EMSDK_IMAGE" = "$UP_EMSDK_IMAGE" ] || return 1
  [ "$ST_EDITION" = "$edition" ] || return 1
  [ "$ST_EXPORT_NAME" = "$(engine_export_of "$edition")" ] || return 1
  [ "$ST_EM_INITIAL_MEMORY_SIZE" = "$UP_EM_INITIAL_MEMORY_SIZE" ] || return 1
  engine_files_present "$DIST_DIR/$ST_ENGINE_DIR" || return 1
  [ "$(engine_content_hash "$DIST_DIR/$ST_ENGINE_DIR")" = "$ST_ENGINE_DIR" ]
}

# dist の評価関数（nn.bin・progress.bin・許諾文）が UPSTREAM の値と一致しているか。
eval_up_to_date() {
  local id=$1 nn progress license
  nn=$DIST_DIR/$(nn_file_of "$id")
  progress=$DIST_DIR/$(progress_file_of "$id")
  license=$DIST_DIR/$(license_file_of "$id")
  [ -f "$nn" ] && [ -f "$progress" ] && [ -f "$license" ] || return 1
  [ "$(sha256_of "$nn")" = "$(eval_get "$id" NN_SHA256)" ] || return 1
  [ "$(sha256_of "$progress")" = "$(eval_get "$id" PROGRESS_SHA256)" ] || return 1
  cmp -s "$license" "$PKG_DIR/$(eval_get "$id" LICENSE_FILE)"
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
# 引数: 残すエンジンのディレクトリ名と、残す評価関数のファイル（dist/engine からの相対）を空白区切りで
prune_dist() {
  local keep_dirs=" $1 " keep_files=" $2 " old name rel
  for old in "$DIST_DIR"/*/; do
    [ -d "$old" ] || continue
    name=$(basename "$old")
    if [[ "$name" =~ ^[0-9a-f]{16}(\.tmp)?$ ]] && [[ "$keep_dirs" != *" $name "* ]]; then
      rm -rf -- "${DIST_DIR:?}/$name"
      log "以前のビルドを消しました: $name"
    fi
  done
  for old in "$DIST_DIR"/eval/nn-*.bin "$DIST_DIR"/eval/progress-*.bin "$DIST_DIR"/eval/license-*.txt \
    "$DIST_DIR"/eval/*.tmp; do
    [ -f "$old" ] || continue
    rel=eval/$(basename "$old")
    if [[ "$keep_files" != *" $rel "* ]]; then
      rm -f -- "$old"
      log "以前の評価関数を消しました: $rel"
    fi
  done
}

# すべてのエンジンと評価関数が揃っていれば dist/engine/manifest.json を書き、その後で以前の配信物を消す。
# 1 つでも UPSTREAM の今の値と合っていなければ manifest を置かない（ファイルは消さない）。
write_manifest() {
  local manifest=$DIST_DIR/manifest.json edition id
  for edition in "${ENGINE_EDITIONS[@]}"; do
    if ! engine_up_to_date "$edition"; then
      rm -f "$manifest"
      log "manifest: エンジン $(engine_name_of "$edition") がまだ無いので書きません（pnpm --filter engine-wasm engine:build）。"
      return 0
    fi
  done
  for id in "${EVAL_ID_LIST[@]}"; do
    if ! eval_up_to_date "$id"; then
      rm -f "$manifest"
      log "manifest: 評価関数 $id がまだ無いので書きません（pnpm --filter engine-wasm engine:eval）。"
      return 0
    fi
  done

  local keep_dirs='' keep_files='' entries='' sep='' dir js_sha worker_sha wasm_sha build_id
  local nn progress license
  for id in "${EVAL_ID_LIST[@]}"; do
    edition=$(eval_get "$id" EDITION)
    engine_up_to_date "$edition" || die "エンジンの状態が途中で変わりました: $edition"
    dir=$DIST_DIR/$ST_ENGINE_DIR
    js_sha=$(sha256_of "$dir/$ENGINE_JS")
    worker_sha=$(sha256_of "$dir/$ENGINE_WORKER")
    wasm_sha=$(sha256_of "$dir/$ENGINE_WASM")
    # 来歴に記録する短い識別子。上流のコミットと、実際にできた wasm の両方で決まる（arch ごとに別になる）。
    build_id=${UP_YANEURAOU_SHA:0:8}-${wasm_sha:0:12}
    nn=$(nn_file_of "$id")
    progress=$(progress_file_of "$id")
    license=$(license_file_of "$id")
    keep_dirs="$keep_dirs $ST_ENGINE_DIR"
    keep_files="$keep_files $nn $progress $license"

    # 値は load_kv が文字種を絞ったものと 16 進だけなので、エスケープは要らない。
    entries+="$sep"$(
      cat <<EOF
    {
      "id": "$id",
      "name": "$(eval_get "$id" NAME)",
      "engine": {
        "buildId": "$build_id",
        "upstreamSha": "$UP_YANEURAOU_SHA",
        "emsdk": "$UP_EMSDK_IMAGE",
        "edition": "$edition",
        "exportName": "$(engine_export_of "$edition")",
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
      "nn": {
        "file": "$nn",
        "bytes": $(bytes_of "$DIST_DIR/$nn"),
        "sha256": "$(eval_get "$id" NN_SHA256)"
      },
      "progress": {
        "file": "$progress",
        "bytes": $(bytes_of "$DIST_DIR/$progress"),
        "sha256": "$(eval_get "$id" PROGRESS_SHA256)"
      },
      "fvScale": $(eval_get "$id" FV_SCALE),
      "license": {
        "name": "$(eval_get "$id" LICENSE)",
        "sourceUrl": "$(eval_get "$id" SOURCE_URL)",
        "file": "$license"
      }
    }
EOF
    )
    sep=$',\n'
  done

  # 失敗は明示的に止める（呼び出し側が if の中で呼んでも、書けなかった manifest のまま先へ進んで消さない）。
  printf '{\n  "defaultId": "%s",\n  "evals": [\n%s\n  ]\n}\n' "$UP_EVAL_DEFAULT" "$entries" >"$manifest.tmp" ||
    die "manifest を書けません: $manifest.tmp"
  mv -f "$manifest.tmp" "$manifest" || die "manifest を切り替えられません: $manifest"
  log "manifest: $manifest を書きました（評価関数 ${EVAL_ID_LIST[*]}・既定 $UP_EVAL_DEFAULT）。"
  prune_dist "$keep_dirs" "$keep_files"
}
