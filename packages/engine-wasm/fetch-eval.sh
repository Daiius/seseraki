#!/usr/bin/env bash
# 評価関数（UPSTREAM の EVAL_IDS。nn.bin と progress.bin）を取得して展開し、大きさと sha256 を UPSTREAM の値と
# 照合してから dist/engine/eval/ に内容ハッシュ入りの名前で置く。照合に通らないものは置かない。
# 許諾文（LICENSE_FILE）も隣に置く。アーカイブの中のほかのファイル（eval_options.txt など）は置かない
# ——eval_options.txt は isready のたびに読まれ、FV_SCALE を上書きする。
set -euo pipefail

# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  cat <<'EOF'
使い方: fetch-eval.sh [--check] [--force] [--from <id>=<ディレクトリ>]...

  --check                  何をするかと現状を表示して終わる（何も変えない）
  --force                  置いてあっても取り直す
  --from <id>=<ディレクトリ>  その評価関数はダウンロードせず、ディレクトリの nn.bin と progress.bin を使う
                           （展開済みのアーカイブなど。大きさと sha256 の照合は同じく行う。繰り返し指定できる）

評価関数の一覧・取得元の URL・sha256 は UPSTREAM から読む。
EOF
}

CHECK=0
FORCE=0
FROM_SPECS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1 ;;
    --force) FORCE=1 ;;
    --from)
      [ $# -ge 2 ] || die "--from には <id>=<ディレクトリ> が要ります。"
      [[ "$2" == ?*=?* ]] || die "--from は <id>=<ディレクトリ> の形にします: $2"
      FROM_SPECS+=("$2")
      shift
      ;;
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

need_cmd sha256sum "評価関数の照合に使います。"
need_cmd cmp "許諾文の照合に使います。"
load_upstream

# --from の id が UPSTREAM にあるかを確かめる。
from_dir_of() {
  local spec
  for spec in "${FROM_SPECS[@]}"; do
    if [ "${spec%%=*}" = "$1" ]; then
      printf '%s' "${spec#*=}"
      return 0
    fi
  done
  return 1
}
for spec in "${FROM_SPECS[@]}"; do
  known=0
  for id in "${EVAL_ID_LIST[@]}"; do
    [ "$id" = "${spec%%=*}" ] && known=1
  done
  [ "$known" -eq 1 ] || die "--from の id が UPSTREAM の EVAL_IDS にありません: ${spec%%=*}"
done

WORK_DIR=$CACHE_DIR/eval

# ホストに 7z があればそれを、無ければ使い捨てコンテナを使う。
find_7z() {
  local c
  for c in 7z 7zz 7za 7zr; do
    if command -v "$c" >/dev/null 2>&1; then
      printf '%s' "$c"
      return 0
    fi
  done
  return 1
}

archive_of() { printf '%s/%s' "$WORK_DIR" "$(basename "$(eval_get "$1" URL)")"; }

# 取り直す評価関数の一覧。
TO_FETCH=()
for id in "${EVAL_ID_LIST[@]}"; do
  log "評価関数:     $id（$(eval_get "$id" NAME)・$(eval_get "$id" EDITION)）"
  if dir=$(from_dir_of "$id"); then
    log "  取得元:     $dir（手元のディレクトリ）"
  else
    log "  取得元:     $(eval_get "$id" URL)"
  fi
  log "  nn.bin:       $(eval_get "$id" NN_BYTES) バイト・sha256 $(eval_get "$id" NN_SHA256) → $(nn_file_of "$id")"
  log "  progress.bin: $(eval_get "$id" PROGRESS_BYTES) バイト・sha256 $(eval_get "$id" PROGRESS_SHA256) → $(progress_file_of "$id")"
  if eval_up_to_date "$id"; then
    log "  現状:       取得済み（sha256 一致）"
    [ "$FORCE" -eq 1 ] && TO_FETCH+=("$id")
  else
    log "  現状:       未取得、または sha256 が合っていない"
    TO_FETCH+=("$id")
  fi
done

if [ "$CHECK" -eq 1 ]; then
  need_download=0
  for id in "${TO_FETCH[@]}"; do
    from_dir_of "$id" >/dev/null && continue
    need_download=1
    if [ -f "$(archive_of "$id")" ]; then
      log "アーカイブ:   $id ダウンロード済み（$(archive_of "$id")）"
    else
      log "アーカイブ:   $id 未ダウンロード"
    fi
  done
  if [ "$need_download" -eq 1 ]; then
    if SEVENZIP=$(find_7z); then
      log "展開:         ホストの $SEVENZIP"
    elif docker_usable; then
      if docker image inspect "$UP_EVAL_EXTRACT_IMAGE" >/dev/null 2>&1; then
        log "展開:         使い捨てコンテナ（$UP_EVAL_EXTRACT_IMAGE・イメージあり）"
      else
        log "展開:         使い捨てコンテナ（$UP_EVAL_EXTRACT_IMAGE・イメージなし。docker pull が要る）"
      fi
    else
      log "展開:         できない（7z も docker も使えない）"
    fi
  fi
  if [ "${#TO_FETCH[@]}" -eq 0 ]; then
    log "実行したら:   何も取り直さない（manifest だけ書き直す）"
  else
    log "実行したら:   ${TO_FETCH[*]} を（ダウンロード → 展開 →）照合 → dist へ置く → manifest を書く"
  fi
  exit 0
fi

if [ "${#TO_FETCH[@]}" -eq 0 ]; then
  log "取得済みなので取り直しません（取り直すなら --force）。"
  write_manifest
  exit 0
fi

# 置く前に必ず通す。大きさと sha256 の両方が期待と一致しなければ止まる。
verify_file() {
  local file=$1 what=$2 expected_bytes=$3 expected_sha=$4 bytes sha
  bytes=$(bytes_of "$file")
  [ "$bytes" = "$expected_bytes" ] ||
    die "$what の大きさが一致しません（期待 $expected_bytes・実際 $bytes）: $file"
  sha=$(sha256_of "$file")
  [ "$sha" = "$expected_sha" ] ||
    die "$what の sha256 が一致しません（期待 $expected_sha・実際 $sha）: $file"
}

# アーカイブから nn.bin と progress.bin を取り出して、それぞれ指定のファイルへ書く。
# 7z には標準出力へ取り出させる（展開先を持たせず、アーカイブの中のパスに書き込ませない）。
# ホストに 7z が無ければ使い捨てコンテナを **1 回だけ**立て、2 つを続けて標準出力へ流す。
# 境目は期待する nn.bin の大きさで切る。中身が期待と違えば、切り方によらず後の照合（verify_file）で止まる。
extract_eval_files() {
  local archive=$1 nn_out=$2 progress_out=$3 nn_bytes=$4
  if SEVENZIP=$(find_7z); then
    "$SEVENZIP" e -so -r "$archive" nn.bin >"$nn_out"
    "$SEVENZIP" e -so -r "$archive" progress.bin >"$progress_out"
    return 0
  fi
  require_docker
  require_image "$UP_EVAL_EXTRACT_IMAGE"
  local both=$nn_out.both
  docker run --rm -v "$archive:/in/archive.7z:ro" "$UP_EVAL_EXTRACT_IMAGE" sh -c '
    set -e
    apt-get update -qq >&2
    apt-get install -y -qq --no-install-recommends p7zip-full >&2
    7z e -so -r /in/archive.7z nn.bin
    7z e -so -r /in/archive.7z progress.bin
  ' >"$both"
  head -c "$nn_bytes" "$both" >"$nn_out"
  tail -c +"$((nn_bytes + 1))" "$both" >"$progress_out"
  rm -f -- "$both"
}

# 一時の名前で置いて確かめ、名前を付け替える。同じ内容がもう置いてあれば置き直さない。
place_file() {
  local source=$1 rel=$2 what=$3 expected_bytes=$4 expected_sha=$5 target=$DIST_DIR/$2
  if [ -f "$target" ] && [ "$(sha256_of "$target")" = "$expected_sha" ]; then
    log "同じ内容が置いてあるので、置き直しません: $rel"
    return 0
  fi
  install -m 644 "$source" "$target.tmp"
  verify_file "$target.tmp" "$what" "$expected_bytes" "$expected_sha"
  mv -f "$target.tmp" "$target"
  log "$what を置きました: $rel"
}

mkdir -p "$WORK_DIR" "$DIST_DIR/eval"

for id in "${TO_FETCH[@]}"; do
  nn_bytes=$(eval_get "$id" NN_BYTES)
  nn_sha=$(eval_get "$id" NN_SHA256)
  progress_bytes=$(eval_get "$id" PROGRESS_BYTES)
  progress_sha=$(eval_get "$id" PROGRESS_SHA256)

  if dir=$(from_dir_of "$id"); then
    [ -f "$dir/nn.bin" ] || die "--from のディレクトリに nn.bin がありません: $dir"
    [ -f "$dir/progress.bin" ] || die "--from のディレクトリに progress.bin がありません: $dir"
    NN_SOURCE=$dir/nn.bin
    PROGRESS_SOURCE=$dir/progress.bin
    cleanup=0
  else
    ARCHIVE=$(archive_of "$id")
    if [ "$FORCE" -eq 1 ]; then rm -f -- "$ARCHIVE"; fi
    if [ ! -s "$ARCHIVE" ]; then
      need_cmd curl "評価関数のダウンロードに使います。"
      log "ダウンロードします: $id..."
      curl -fL --retry 3 -o "$ARCHIVE.part" "$(eval_get "$id" URL)"
      mv -f "$ARCHIVE.part" "$ARCHIVE"
    fi
    # 展開する前に、アーカイブそのものを照合する（壊れた・差し替えられたものを開かない）。
    verify_file "$ARCHIVE" "$id のアーカイブ" "$(eval_get "$id" ARCHIVE_BYTES)" "$(eval_get "$id" ARCHIVE_SHA256)"

    NN_SOURCE=$WORK_DIR/$id.nn.bin
    PROGRESS_SOURCE=$WORK_DIR/$id.progress.bin
    rm -f -- "$NN_SOURCE" "$PROGRESS_SOURCE"
    log "展開します: $id..."
    extract_eval_files "$ARCHIVE" "$NN_SOURCE" "$PROGRESS_SOURCE" "$nn_bytes"
    cleanup=1
  fi

  verify_file "$NN_SOURCE" "$id の nn.bin" "$nn_bytes" "$nn_sha"
  verify_file "$PROGRESS_SOURCE" "$id の progress.bin" "$progress_bytes" "$progress_sha"

  # 順序: 一時の名前で置いて確かめる → 名前を付け替える → manifest を切り替える → 以前のものを消す。
  # 以前の評価関数は manifest を切り替え終わるまで消さない（write_manifest の最後で消す）。
  # 途中で失敗しても、残っている manifest が指すファイルは残る。
  place_file "$NN_SOURCE" "$(nn_file_of "$id")" "$id の nn.bin" "$nn_bytes" "$nn_sha"
  place_file "$PROGRESS_SOURCE" "$(progress_file_of "$id")" "$id の progress.bin" "$progress_bytes" "$progress_sha"
  license_src=$PKG_DIR/$(eval_get "$id" LICENSE_FILE)
  place_file "$license_src" "$(license_file_of "$id")" "$id の許諾文" "$(bytes_of "$license_src")" "$(sha256_of "$license_src")"

  # 展開した中間ファイルは残さない（アーカイブは次回のために残す）。
  if [ "$cleanup" -eq 1 ]; then rm -f -- "$NN_SOURCE" "$PROGRESS_SOURCE"; fi
done

write_manifest
