#!/usr/bin/env bash
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "node is required for smoke-host-integration.sh" >&2
  exit 1
fi

export QWEN_HEADFUL="${QWEN_HEADFUL:-1}"
export QWEN_USE_MOCK_HOST=1

echo "Running Qwen host integration smoke test with Playwright mock host..."
node tests/driver.ts
