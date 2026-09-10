#!/usr/bin/env bash
# Rebuild from vendored source only; no grammar repository is fetched.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if ! command -v tree-sitter >/dev/null || ! tree-sitter --version | grep -Eq '^tree-sitter 0\.25\.10( |$)'; then
  echo 'Install the pinned compiler: npm install --global tree-sitter-cli@0.25.10' >&2
  exit 1
fi
cd "$ROOT/vendor/tree-sitter-robot"
tree-sitter generate --abi 14
tree-sitter test
tree-sitter build --wasm
cp tree-sitter-robot.wasm "$ROOT/src/extraction/wasm/tree-sitter-robot.wasm"
chmod 644 "$ROOT/src/extraction/wasm/tree-sitter-robot.wasm"
rm tree-sitter-robot.wasm
