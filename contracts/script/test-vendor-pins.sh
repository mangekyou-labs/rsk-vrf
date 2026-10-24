#!/usr/bin/env bash
# Tests check-vendor-pins.sh against copies of the vendor tree. The check must
# pass on the tree as committed and fail when:
#   - any vendored file is changed or missing,
#   - a PINS line is tampered with, even if the file is changed to match it,
#   - a file under src/vendor/ isn't listed in PINS.
# It asks the checker for the vendored file list so PINS is parsed in one place.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
contracts="$(dirname "$here")"
check="$here/check-vendor-pins.sh"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
tree="$work/tree"

fail() { echo "FAIL: $*" >&2; exit 1; }

copy_tree() {
  rm -rf "$tree"
  mkdir -p "$tree/src"
  cp -R "$contracts/src/vendor" "$tree/src/vendor"
}

passes() { "$check" "$tree" >/dev/null 2>&1; }

expect_pass() { passes || fail "pins should pass $*"; }
expect_fail() { if passes; then fail "pins should fail $*"; fi; }

# Replaces the first match of the sed expression $1 in the copied PINS.
edit_pins() {
  sed -e "$1" "$tree/src/vendor/PINS" >"$work/PINS"
  cmp -s "$work/PINS" "$tree/src/vendor/PINS" && fail "PINS edit '$1' changed nothing"
  mv "$work/PINS" "$tree/src/vendor/PINS"
}

copy_tree
expect_pass "on the committed vendor tree"

copy_tree
printf '\nedited\n' >>"$tree/src/vendor/README.md"
expect_pass "when only README.md changes"

files="$("$check" --list "$contracts")"
[[ -n "$files" ]] || fail "--list printed no vendored files"
while read -r local; do
  copy_tree
  printf '\n' >>"$tree/$local"
  expect_fail "when $local gains a trailing newline"

  copy_tree
  rm "$tree/$local"
  expect_fail "when $local is missing"

  copy_tree
  grep -v " $local\$" "$tree/src/vendor/PINS" >"$work/PINS"
  mv "$work/PINS" "$tree/src/vendor/PINS"
  expect_fail "when the PINS line for $local is removed"
done <<<"$files"

# A tampered PINS line, with the file changed so its hash matches the new pin.
vrf="src/vendor/chainlink/VRF.sol"
copy_tree
printf '\n' >>"$tree/$vrf"
edit_pins "s/^0aa7ffeb87a5c9d72657aa992639d54a2c9bc3b8 /$(git hash-object --no-filters "$tree/$vrf") /"
expect_fail "when VRF.sol and its PINS blob change together"

copy_tree
edit_pins "s/chainlink-evm@23aa97639f630240f34b79b98d6b38baa094ccc5/chainlink-evm@0000000000000000000000000000000000000000/"
expect_fail "when the VRF.sol PINS commit changes"

copy_tree
edit_pins "/BLS.sol /s/bls-bn254@9f70fb4dff2cd0921dc2144929dc0aff6f21a9b9/bls-bn254@0000000000000000000000000000000000000000/"
expect_fail "when a bls-bn254 PINS commit changes"

copy_tree
edit_pins "s|contracts/src/v0.8/vrf/VRF.sol|contracts/src/v0.8/vrf/Other.sol|"
expect_fail "when the VRF.sol upstream path changes"

copy_tree
printf 'pragma solidity ^0.8.0;\n' >"$tree/src/vendor/chainlink/Extra.sol"
expect_fail "when src/vendor/ holds a file that isn't in PINS"

copy_tree
mkdir -p "$tree/src/vendor/other"
printf 'x\n' >"$tree/src/vendor/other/README.md"
expect_fail "when a nested README.md isn't in PINS"

echo "vendor pin check tests passed"
