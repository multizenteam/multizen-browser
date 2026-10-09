#!/bin/bash
#
# MultiZen - install the AppArmor userns profile for the CloakBrowser engine.
#
# Runs as root via a single `pkexec` call. It receives the profile TEXT on
# stdin (never as an argument), validates it against a fixed template and an
# attach-path allowlist, writes it to a FIXED filename, and loads it. The script
# is shipped read-only inside the app bundle; it takes no caller-controlled
# path, so it cannot be redirected to grant userns to an unintended binary.
#
# Exit codes (consumed by the app's pkexec result mapper):
#   0  success (profile written + loaded)
#   10 stdin failed the template / attach-path validation
#   11 apparmor_parser rejected the profile (e.g. too-old parser, no userns rule)
#   12 writing the profile file failed
#   13 loading the profile failed
#   20 usage error (unknown mode)
# pkexec itself returns 126 (user dismissed) / 127 (not authorized) before us.

set -euo pipefail
export PATH="/usr/sbin:/usr/bin:/sbin:/bin"

PROFILE_PATH="/etc/apparmor.d/multizen-cloakbrowser"
PROFILE_NAME="multizen-cloakbrowser"

mode="${1:-install}"

remove_profile() {
  # Unload by name if loaded, then delete the file. Best-effort; a missing
  # file/already-unloaded profile is not an error.
  if [ -f "$PROFILE_PATH" ]; then
    apparmor_parser -R "$PROFILE_PATH" 2>/dev/null || true
    rm -f "$PROFILE_PATH"
  fi
  exit 0
}

if [ "$mode" = "--remove" ]; then
  remove_profile
fi
if [ "$mode" != "install" ]; then
  echo "usage: install-apparmor-profile.sh [--remove]" >&2
  exit 20
fi

# Read the whole profile text from stdin.
stdin_text="$(cat)"

# Pull the attach path out of the single `profile ... flags=(unconfined) {` line.
attach_path="$(
  printf '%s\n' "$stdin_text" \
    | sed -n "s|^profile ${PROFILE_NAME} \(/[^ ]*\) flags=(unconfined) {\$|\1|p"
)"

# Validate the attach path: absolute, no spaces, under the engine cache tree,
# ending in the versioned glob, and free of path-traversal. Reject otherwise.
case "$attach_path" in
  *".."*) echo "invalid attach path (traversal)" >&2; exit 10 ;;
esac
if ! printf '%s' "$attach_path" \
  | grep -Eq '^/[^[:space:]]*/chromium/cloakbrowser/\*\*/chrome$'; then
  echo "attach path not in the allowed engine location" >&2
  exit 10
fi

# Rebuild the canonical profile from the validated path and require the stdin to
# match it byte-for-byte. Only the attach path is variable; everything else is
# fixed, so a tampered stdin (extra rules, different target) is rejected here.
canonical="$(cat <<EOF
abi <abi/4.0>,
include <tunables/global>

profile ${PROFILE_NAME} ${attach_path} flags=(unconfined) {
  userns,
}
EOF
)"

if [ "$stdin_text" != "$canonical" ]; then
  echo "profile text did not match the expected template" >&2
  exit 10
fi

# Validate the policy without loading it into the kernel (needs no root, but we
# are already root here; this catches a too-old parser that cannot parse the
# abi/4.0 + userns rule).
if ! printf '%s' "$canonical" | apparmor_parser -Q -K >/dev/null 2>&1; then
  echo "apparmor_parser rejected the profile (unsupported)" >&2
  exit 11
fi

# Write the canonical text (not the raw stdin) to the FIXED path.
if ! printf '%s\n' "$canonical" >"$PROFILE_PATH"; then
  echo "failed to write $PROFILE_PATH" >&2
  exit 12
fi
chmod 0644 "$PROFILE_PATH"

# Load (replace) the profile so it takes effect immediately, no reboot. If the
# load fails, remove the file so we never leave a present-but-unloaded profile
# (which would make the app's verify step think the sandbox is active).
if ! apparmor_parser -r "$PROFILE_PATH"; then
  echo "failed to load $PROFILE_PATH" >&2
  rm -f "$PROFILE_PATH"
  exit 13
fi

exit 0
