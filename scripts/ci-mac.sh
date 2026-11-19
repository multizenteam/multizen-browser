#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
commit="$(git -C "$root" rev-parse HEAD)"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/sekvona-mac.XXXXXX")"
checkout="$scratch/src"
cleanup() {
  if [[ -d "$checkout" ]]; then
    git -C "$root" worktree remove --force "$checkout"
  fi
  rmdir "$scratch"
}
trap cleanup EXIT

git -C "$root" worktree add --detach "$checkout" "$commit"
cd "$checkout"
yarn install --immutable
CSC_IDENTITY_AUTO_DISCOVERY=false yarn dist:mac
arch="$(uname -m)"
cd "dist/macos-${arch/x86_64/x64}"
shasum -a 256 -c SHA256SUMS
mkdir -p "$root/dist/ci"
target="$(mktemp -d "$root/dist/ci/${commit:0:12}-$arch.XXXXXX")"
cp ./*.dmg ./*.zip SHA256SUMS INSTALL.txt "$target/"
cd "$target"
shasum -a 256 -c SHA256SUMS
echo "Verified installers in $target"
