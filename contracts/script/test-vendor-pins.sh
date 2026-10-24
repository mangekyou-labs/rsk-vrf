#!/usr/bin/env bash
# Tests check-vendor-pins.sh: it passes on the vendored tree as committed and
# fails when any pinned file is changed or missing.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
contracts="$(dirname "$here")"
check="$here/check-vendor-pins.sh"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

copy_tree() {
  rm -rf "$work/tree"
  mkdir -p "$work/tree/src"
  cp -R "$contracts/src/vendor" "$work/tree/src/vendor"
}

copy_tree
"$check" "$work/tree" >/dev/null || fail "pins should pass on the committed vendor tree"

while read -r blob _source _path local; do
  [[ -z "$blob" || "$blob" == \#* ]] && continue

  copy_tree
  printf '\n' >>"$work/tree/$local"
  if "$check" "$work/tree" >/dev/null 2>&1; then
    fail "pins should fail when $local gains a trailing newline"
  fi

  copy_tree
  rm "$work/tree/$local"
  if "$check" "$work/tree" >/dev/null 2>&1; then
    fail "pins should fail when $local is missing"
  fi
done <"$contracts/src/vendor/PINS"

echo "vendor pin check tests passed"
