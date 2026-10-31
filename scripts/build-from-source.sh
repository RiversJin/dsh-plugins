#!/usr/bin/env bash
# Build every tarball the kit needs from public source and place them in kit/packages/.
#
#   scripts/build-from-source.sh [--workdir DIR] [--skip-harness]
#
# Sources (all public):
#   RiversJin/deepseek-harness  local/schedule-idle-0.2.1-rc.5  -> 7 patched @deepseek-ai/dsh-* packages
#   RiversJin/dsh-plugins       (this checkout)                  -> 12 @riversjin/dsh-* plugins
#   RiversJin/dsh-layered-memory  upgrade/dsh-0.2.1-rc.5
#   RiversJin/dsh-qqbot           upgrade/dsh-0.2.1-rc.5
#   RiversJin/dsh-usage-stats     upgrade/dsh-0.2.1-rc.5
#   RiversJin/dsh-soul-md         rivers/dsh-0.2.1-rc.5
#
# Needs: git, Node >= 24, pnpm >= 11, npm. The harness monorepo is the slow part
# (several GB of node_modules, roughly 10-30 minutes on a laptop); --skip-harness
# reuses deepseek-ai-dsh-*.tgz already present in kit/packages/.
set -euo pipefail
shopt -s inherit_errexit
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
OUT="$ROOT/kit/packages"
WORK="${XDG_CACHE_HOME:-$HOME/.cache}/dsh-companion-src"; SKIP_HARNESS=0
while [ $# -gt 0 ]; do
  case $1 in
    --workdir) WORK=$2; shift 2;;
    --skip-harness) SKIP_HARNESS=1; shift;;
    *) echo "unknown option: $1" >&2; exit 2;;
  esac
done
command -v git >/dev/null && command -v pnpm >/dev/null && command -v npm >/dev/null || { echo "git, pnpm and npm must be on PATH" >&2; exit 2; }
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 24 ] || { echo "Node >= 24 required" >&2; exit 2; }
mkdir -p "$WORK" "$OUT"

# retry <cmd...>: network steps get three attempts
retry() {
  local n
  for n in 1 2 3; do "$@" && return 0; echo "  attempt $n failed: $*" >&2; sleep $((n * 10)); done
  return 1
}
# checkout <repo> <branch> -> prints the directory
checkout() {
  local dir="$WORK/${1##*/}"
  if [ ! -d "$dir/.git" ]; then
    rm -rf "$dir"
    retry git clone -q --depth 1 --branch "$2" "https://github.com/$1.git" "$dir" >&2
  else
    retry git -C "$dir" fetch -q --depth 1 origin "$2" >&2
    git -C "$dir" checkout -q -B "$2" FETCH_HEAD >&2
  fi
  echo "$dir"
}
# install dependencies with the lockfile the repository carries
install_deps() {
  if [ -f pnpm-lock.yaml ]; then retry pnpm install --frozen-lockfile; else retry npm ci; fi
}

if [ "$SKIP_HARNESS" = 0 ]; then
  echo "== harness (patched upstream packages)"
  H=$(checkout RiversJin/deepseek-harness local/schedule-idle-0.2.1-rc.5)
  (cd "$H"; retry pnpm install --frozen-lockfile; pnpm run build:lib)
  rm -f "$OUT"/deepseek-ai-dsh-*.tgz
  for p in client/ui-schedule compaction/compaction-basic schedule/schedule schedule/tool-schedule \
           session/session-format-v3-to-v4 session/session-persistence-jsonl context/time-context; do
    (cd "$H/packages/$p" && pnpm pack --pack-destination "$OUT" >/dev/null)
    echo "  packed packages/$p"
  done
fi

echo "== forks"
for spec in RiversJin/dsh-layered-memory:upgrade/dsh-0.2.1-rc.5 RiversJin/dsh-qqbot:upgrade/dsh-0.2.1-rc.5 \
            RiversJin/dsh-usage-stats:upgrade/dsh-0.2.1-rc.5 RiversJin/dsh-soul-md:rivers/dsh-0.2.1-rc.5; do
  repo=${spec%%:*}; branch=${spec#*:}
  d=$(checkout "$repo" "$branch")
  (cd "$d"
   # Plain-JS packages (soul-md) have no build step and are packed as they are.
   if node -e 'process.exit(require("./package.json").scripts?.build ? 0 : 1)'; then install_deps; npm run build; fi
   npm pack -q --ignore-scripts --pack-destination "$OUT" >/dev/null)
  echo "  packed $repo"
done

echo "== @riversjin plugins"
(cd "$ROOT"; retry pnpm install --frozen-lockfile; scripts/pack-kit.sh)

echo "== kit/packages"
ls -1 "$OUT"/*.tgz | sed 's#.*/#  #'
