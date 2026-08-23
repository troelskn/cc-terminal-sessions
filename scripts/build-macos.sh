#!/bin/bash
# Builds the bundled .app for the machine's real architecture.
#
# Detection uses sysctl, not `uname -m`: a shell running under Rosetta
# reports x86_64 from uname even on Apple Silicon hardware.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]; then
  target=aarch64-apple-darwin
  # The rustup toolchain provides the aarch64 std; a Homebrew rust earlier
  # on PATH may be x86_64-only. Prepend, so plain `cargo` still works for
  # setups without rustup.
  export PATH="$HOME/.cargo/bin:$PATH"
else
  target=x86_64-apple-darwin
fi

echo "building for $target"
exec npx tauri build --target "$target" "$@"
