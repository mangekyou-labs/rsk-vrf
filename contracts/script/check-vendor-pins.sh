#!/usr/bin/env bash
# Checks every vendored file against its pinned upstream git blob hash.
#
# Usage: check-vendor-pins.sh [--upstream] [contracts-dir]
#
# Without flags it hashes the local files with `git hash-object` and compares
# them with src/vendor/PINS. With --upstream it also downloads each file from
# GitHub at the pinned commit and checks that the pin itself matches upstream.
set -euo pipefail

upstream=0
if [[ "${1:-}" == "--upstream" ]]; then
  upstream=1
  shift
fi

here="$(cd "$(dirname "$0")" && pwd)"
pins="$(dirname "$here")/src/vendor/PINS"
root="${1:-$(dirname "$here")}"

status=0
while read -r blob source path local; do
  [[ -z "$blob" || "$blob" == \#* ]] && continue

  file="$root/$local"
  if [[ ! -f "$file" ]]; then
    echo "MISSING  $local (pinned $blob from $source)" >&2
    status=1
    continue
  fi

  actual="$(git hash-object --no-filters "$file")"
  if [[ "$actual" != "$blob" ]]; then
    echo "MODIFIED $local: blob $actual, pinned $blob from $source" >&2
    status=1
    continue
  fi

  if [[ "$upstream" == 1 ]]; then
    repo="${source%@*}"
    commit="${source#*@}"
    remote="$(curl -fsSL "https://raw.githubusercontent.com/$repo/$commit/$path" | git hash-object --no-filters --stdin)"
    if [[ "$remote" != "$blob" ]]; then
      echo "UPSTREAM $local: $repo@$commit:$path is blob $remote, pinned $blob" >&2
      status=1
      continue
    fi
  fi

  echo "ok       $local $blob"
done <"$pins"

exit "$status"
