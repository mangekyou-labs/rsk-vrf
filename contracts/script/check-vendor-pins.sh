#!/usr/bin/env bash
# Checks every vendored file against its pinned upstream git blob hash.
#
# Usage: check-vendor-pins.sh [--upstream | --list] [contracts-dir]
#
# Without flags it checks that:
#   - src/vendor/PINS matches the pins hard-coded below, so a PR can't move a
#     pin by editing PINS alone,
#   - every file under src/vendor/ (except README.md and PINS) is in PINS,
#   - each pinned file's `git hash-object` equals its pin.
# With --upstream it also downloads each file from GitHub at the pinned commit
# and checks that the pin itself matches upstream. With --list it only prints
# the pinned local paths, one per line.
set -euo pipefail

# The expected pins, one record per line, in PINS column order. Changing a pin
# means changing it here and in PINS.
expected="\
0aa7ffeb87a5c9d72657aa992639d54a2c9bc3b8 smartcontractkit/chainlink-evm@23aa97639f630240f34b79b98d6b38baa094ccc5 contracts/src/v0.8/vrf/VRF.sol src/vendor/chainlink/VRF.sol
07d4ec712ee5a0d256a99ebad6f3157c84436edb smartcontractkit/chainlink-evm@23aa97639f630240f34b79b98d6b38baa094ccc5 LICENSE src/vendor/chainlink/LICENSE
dd2332b589fd68878f7c0300737b1a0913b5001a kevincharm/bls-bn254@9f70fb4dff2cd0921dc2144929dc0aff6f21a9b9 contracts/BLS.sol src/vendor/bls-bn254/BLS.sol
d1ff4297d5c1cca8d2800140a5df4d792d4476d7 kevincharm/bls-bn254@9f70fb4dff2cd0921dc2144929dc0aff6f21a9b9 contracts/ModExp.sol src/vendor/bls-bn254/ModExp.sol
96adf9a236c914eef25cae55c37c1b0f890fc902 kevincharm/bls-bn254@9f70fb4dff2cd0921dc2144929dc0aff6f21a9b9 LICENSE src/vendor/bls-bn254/LICENSE"

mode=check
case "${1:-}" in
  --upstream) mode=upstream; shift ;;
  --list) mode=list; shift ;;
esac

here="$(cd "$(dirname "$0")" && pwd)"
root="${1:-$(dirname "$here")}"
pins="$root/src/vendor/PINS"

# records prints PINS without comments or blank lines, one space between fields.
records() {
  local blob source path local
  while read -r blob source path local; do
    [[ -z "$blob" || "$blob" == \#* ]] && continue
    echo "$blob $source $path $local"
  done <"$pins"
}

if [[ "$mode" == list ]]; then
  records | cut -d' ' -f4
  exit 0
fi

status=0

if ! diff <(echo "$expected") <(records) >&2; then
  echo "PINS     $pins differs from the pins hard-coded in $0 (< expected, > PINS)" >&2
  status=1
fi

pinned="$(records | cut -d' ' -f4)"
while read -r file; do
  local="src/vendor/${file#"$root/src/vendor/"}"
  [[ "$local" == src/vendor/README.md || "$local" == src/vendor/PINS ]] && continue
  if ! grep -qxF "$local" <<<"$pinned"; then
    echo "UNPINNED $local is under src/vendor/ but not in PINS" >&2
    status=1
  fi
done < <(find "$root/src/vendor" -type f | LC_ALL=C sort)

while read -r blob source path local; do
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

  if [[ "$mode" == upstream ]]; then
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
done < <(records)

exit "$status"
