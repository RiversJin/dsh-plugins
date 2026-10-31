#!/usr/bin/env bash
# Install the patched DSH runtime and a companion profile from this kit.
#
#   kit/install.sh --dsh-home ~/.dsh --workspace ~/companion --name 月见 --user 我 \
#                  [--time-zone Asia/Shanghai] [--profile web]
#
# Needs: Linux x64, Node >= 24, pnpm >= 11 on PATH. Nothing outside --dsh-home is written.
# Re-running replaces runtime/dsh-0.2.1-rc.5 and profiles/<profile> (sessions and storages are untouched).
set -euo pipefail
KIT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
DSH_HOME_DIR=${DSH_HOME:-$HOME/.dsh}; WORKSPACE=""; ASSISTANT=""; USER_NAME="用户"; TZ_NAME=$(timedatectl show -p Timezone --value 2>/dev/null || echo UTC); PROFILE=web
while [ $# -gt 0 ]; do
  case $1 in
    --dsh-home) DSH_HOME_DIR=$2; shift 2;;
    --workspace) WORKSPACE=$2; shift 2;;
    --name) ASSISTANT=$2; shift 2;;
    --user) USER_NAME=$2; shift 2;;
    --time-zone) TZ_NAME=$2; shift 2;;
    --profile) PROFILE=$2; shift 2;;
    *) echo "unknown option: $1" >&2; exit 2;;
  esac
done
[ -n "$WORKSPACE" ] && [ -n "$ASSISTANT" ] || { echo "--workspace and --name are required" >&2; exit 2; }
command -v node >/dev/null && command -v pnpm >/dev/null || { echo "node and pnpm must be on PATH" >&2; exit 2; }
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]'); [ "$NODE_MAJOR" -ge 24 ] || { echo "Node >= 24 required (found $(node -v))" >&2; exit 2; }
ls "$KIT"/packages/*.tgz >/dev/null 2>&1 || { echo "kit/packages/ has no tarballs; download the release assets or run scripts/pack-kit.sh" >&2; exit 2; }
export DSH_HOME="$DSH_HOME_DIR" DSH_TELEMETRY_DISABLED=${DSH_TELEMETRY_DISABLED:-1}
mkdir -p "$DSH_HOME" "$WORKSPACE"

RT="$DSH_HOME/runtime/dsh-0.2.1-rc.5"
echo "== runtime -> $RT"
rm -rf "${RT:?}"; mkdir -p "$RT/upgrade-packages"
cp -a "$KIT/runtime/." "$RT/"
cp "$KIT"/packages/deepseek-ai-dsh-*.tgz "$RT/upgrade-packages/"
(cd "$RT" && pnpm install --config.confirmModulesPurge=false)
BIN="$RT/node_modules/@deepseek-ai/dsh/lib/bin.js"; test -f "$BIN"
grep -q '"version": "1.1.0"' "$RT/node_modules/@earendil-works/pi-ai/package.json"
grep -q registerScheduleContext "$RT/node_modules/@deepseek-ai/dsh-schedule/lib/index.js"

P="$DSH_HOME/profiles/$PROFILE"
echo "== profile -> $P"
rm -rf "${P:?}"; mkdir -p "$P/.upgrade-packages"
cp -a "$KIT/profile-template/." "$P/"
cp "$KIT"/packages/riversjin-*.tgz "$KIT"/packages/dsh-layered-memory-*.tgz "$KIT"/packages/dsh-soul-md-*.tgz "$KIT"/packages/dsh-usage-stats-*.tgz "$KIT"/packages/tencent-connect-dsh-qqbot-*.tgz "$P/.upgrade-packages/"
sed -i "s#__DSH_HOME__#$DSH_HOME#g; s#__WORKSPACE__#$WORKSPACE#g; s#__ASSISTANT_NAME__#$ASSISTANT#g; s#__USER_NAME__#$USER_NAME#g; s#__TIME_ZONE__#$TZ_NAME#g" "$P/cordis.patch.yml"
mkdir -p "$DSH_HOME/memory-layered" "$DSH_HOME/dream-context/objects" "$DSH_HOME/dream-context/embeddings"
(cd "$HOME" && node --expose-internals "$BIN" plugin --profile "$PROFILE" install)
node --expose-internals "$BIN" --profile "$PROFILE" --dump-config > "$P/dump-config.yml"
echo "== installed. dump-config: $(wc -l < "$P/dump-config.yml") lines"
cat <<MSG

Start the Web host (set KIMI_CODING_API_KEY and DEEPSEEK_API_KEY first):

  DSH_HOME=$DSH_HOME node --expose-internals $BIN web --profile $PROFILE --host 127.0.0.1 --port 3080

Then edit $P/cordis.patch.yml: persona card under soul-md, QQ bot (disabled by default),
and add your main session id to schedule.timePassingSessions once it exists.
MSG
