#!/usr/bin/env bash
# 評価関数（水匠5 の nn.bin）を取得して展開し、sha256 を UPSTREAM の値と照合してから
# dist/engine/eval/nn-<sha256 の先頭 16 桁>.bin に置く。照合に通らないものは置かない。
set -euo pipefail

# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  cat <<'EOF'
使い方: fetch-eval.sh [--check] [--force] [--from <nn.bin のパス>]

  --check        何をするかと現状を表示して終わる（何も変えない）
  --force        置いてあっても取り直す
  --from <path>  ダウンロードせず、手元の nn.bin を使う（sha256 の照合は同じく行う）

取得元の URL・sha256 は UPSTREAM から読む。
EOF
}

CHECK=0
FORCE=0
FROM=''
while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1 ;;
    --force) FORCE=1 ;;
    --from)
      [ $# -ge 2 ] || die "--from にはパスが要ります。"
      FROM=$2
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
load_upstream

TARGET=$DIST_DIR/$EVAL_FILE
WORK_DIR=$CACHE_DIR/eval
ARCHIVE=$WORK_DIR/$(basename "$UP_EVAL_URL")

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

UP_TO_DATE=0
if eval_up_to_date; then UP_TO_DATE=1; fi

log "評価関数:     $UP_EVAL_NAME（$UP_EVAL_ENTRY・$UP_EVAL_BYTES バイト）"
log "sha256:       $UP_EVAL_SHA256"
if [ -n "$FROM" ]; then
  log "取得元:       $FROM（手元のファイル）"
else
  log "取得元:       $UP_EVAL_URL"
fi
log "置き場:       $TARGET"
if [ "$UP_TO_DATE" -eq 1 ]; then
  log "現状:         取得済み（sha256 一致）"
else
  log "現状:         未取得、または sha256 が合っていない"
fi

if [ "$CHECK" -eq 1 ]; then
  if [ -z "$FROM" ]; then
    if [ -f "$ARCHIVE" ]; then
      log "アーカイブ:   ダウンロード済み（$ARCHIVE）"
    else
      log "アーカイブ:   未ダウンロード"
    fi
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
  if [ "$UP_TO_DATE" -eq 1 ] && [ "$FORCE" -eq 0 ]; then
    log "実行したら:   何も取り直さない（manifest だけ書き直す）"
  elif [ -n "$FROM" ]; then
    log "実行したら:   手元のファイルを照合 → dist へ置く → manifest を書く"
  else
    log "実行したら:   ダウンロード → 展開 → 照合 → dist へ置く → manifest を書く"
  fi
  exit 0
fi

if [ "$UP_TO_DATE" -eq 1 ] && [ "$FORCE" -eq 0 ]; then
  log "取得済みなので取り直しません（取り直すなら --force）。"
  write_manifest
  exit 0
fi

# 置く前に必ず通す。大きさと sha256 の両方が UPSTREAM と一致しなければ止まる。
verify_eval() {
  local file=$1 bytes sha
  bytes=$(wc -c <"$file")
  bytes=${bytes//[[:space:]]/}
  [ "$bytes" = "$UP_EVAL_BYTES" ] ||
    die "評価関数の大きさが一致しません（期待 $UP_EVAL_BYTES・実際 $bytes）: $file"
  sha=$(sha256_of "$file")
  [ "$sha" = "$UP_EVAL_SHA256" ] ||
    die "評価関数の sha256 が一致しません（期待 $UP_EVAL_SHA256・実際 $sha）: $file"
}

mkdir -p "$WORK_DIR"

if [ -n "$FROM" ]; then
  [ -f "$FROM" ] || die "--from のファイルがありません: $FROM"
  SOURCE=$FROM
else
  if [ "$FORCE" -eq 1 ]; then rm -f -- "$ARCHIVE"; fi
  if [ ! -s "$ARCHIVE" ]; then
    need_cmd curl "評価関数のダウンロードに使います。"
    log "ダウンロードします..."
    curl -fL --retry 3 -o "$ARCHIVE.part" "$UP_EVAL_URL"
    mv -f "$ARCHIVE.part" "$ARCHIVE"
  fi

  SOURCE=$WORK_DIR/$UP_EVAL_ENTRY
  rm -f -- "$SOURCE"
  log "展開します..."
  # 展開先を持たせず標準出力へ出させる（アーカイブの中のパスに書き込ませない）。
  if SEVENZIP=$(find_7z); then
    "$SEVENZIP" e -so -r "$ARCHIVE" "$UP_EVAL_ENTRY" >"$SOURCE"
  else
    require_docker
    require_image "$UP_EVAL_EXTRACT_IMAGE"
    docker run --rm -v "$ARCHIVE:/in/archive.7z:ro" "$UP_EVAL_EXTRACT_IMAGE" sh -c '
      set -e
      apt-get update -qq >&2
      apt-get install -y -qq --no-install-recommends p7zip-full >&2
      exec 7z e -so -r /in/archive.7z "$1"
    ' sh "$UP_EVAL_ENTRY" >"$SOURCE"
  fi
fi

verify_eval "$SOURCE"

mkdir -p "$(dirname "$TARGET")"
# 配信物の形を「今の評価関数だけ」に保つ。以前の評価関数は消す。
for old in "$DIST_DIR"/eval/nn-*.bin; do
  [ -f "$old" ] || continue
  if [ "$old" != "$TARGET" ]; then
    rm -f -- "$old"
    log "以前の評価関数を消しました: $(basename "$old")"
  fi
done
install -m 644 "$SOURCE" "$TARGET.tmp"
mv -f "$TARGET.tmp" "$TARGET"
# 展開した中間ファイルは残さない（アーカイブは次回のために残す）。
if [ -z "$FROM" ]; then rm -f -- "$SOURCE"; fi

log "評価関数を置きました: $TARGET"
write_manifest
