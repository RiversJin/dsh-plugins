#!/usr/bin/env bash
# Build every workspace package and pack the tarballs into kit/packages/.
# Harness and fork tarballs are copied from --extra <dir> when given (they are not built here).
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
EXTRA=""; [ "${1:-}" = "--extra" ] && EXTRA=$2
cd "$ROOT"
pnpm -r --if-present build
mkdir -p kit/packages
rm -f kit/packages/riversjin-*.tgz
for d in packages/*/; do (cd "$d" && pnpm pack --pack-destination "$ROOT/kit/packages" >/dev/null && echo "packed $(node -p 'require("./package.json").name')"); done
if [ -n "$EXTRA" ]; then cp "$EXTRA"/deepseek-ai-dsh-*.tgz "$EXTRA"/dsh-layered-memory-*.tgz "$EXTRA"/dsh-soul-md-*.tgz "$EXTRA"/dsh-usage-stats-*.tgz "$EXTRA"/tencent-connect-dsh-qqbot-*.tgz kit/packages/; fi
ls -1 kit/packages/*.tgz | sed 's#.*/##'
