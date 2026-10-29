#!/usr/bin/env sh
set -eu

: "${GRANITE_VAULT:=/vault}"
export GRANITE_VAULT

# Railway's container filesystem is ephemeral. Refuse to create a vault there.
if [ -n "${RAILWAY_PROJECT_ID:-}" ]; then
  : "${GRANITE_MCP_TOKEN:?Set GRANITE_MCP_TOKEN in Railway service variables}"
  : "${TYPESAFE_API_KEY:?Set TYPESAFE_API_KEY in Railway service variables}"
  : "${RAILWAY_VOLUME_MOUNT_PATH:?Attach a Railway volume at /vault before deploying}"
  # Resolve existing ancestors before creating anything; symlinks cannot escape the volume.
  node --input-type=module -e '
    import fs from "node:fs";
    import path from "node:path";
    const mount = fs.realpathSync(process.env.RAILWAY_VOLUME_MOUNT_PATH);
    const requested = path.resolve(process.env.GRANITE_VAULT);
    let ancestor = requested;
    while (!fs.lstatSync(ancestor, { throwIfNoEntry: false })) ancestor = path.dirname(ancestor);
    const resolved = path.resolve(fs.realpathSync(ancestor), path.relative(ancestor, requested));
    if (resolved !== mount && !resolved.startsWith(mount + path.sep)) {
      console.error("GRANITE_VAULT must be inside RAILWAY_VOLUME_MOUNT_PATH.");
      process.exit(1);
    }
  '
  export GRANITE_DISABLE_DOCUMENT_PARSING=1
fi

# Read-only runtime handshake: proves this running image supports descendant vaults.
if [ "${1:-}" = "--granite-migration-capability" ]; then
  node -e 'console.log(JSON.stringify({capability:"granite-railway-migration-v1",mount:process.env.RAILWAY_VOLUME_MOUNT_PATH,vault:process.env.GRANITE_VAULT,service:process.env.RAILWAY_SERVICE_NAME,volume:process.env.RAILWAY_VOLUME_NAME}))'
  exit 0
fi

if [ ! -f "$GRANITE_VAULT/granite.yml" ]; then
  mkdir -p "$GRANITE_VAULT"
  if [ -n "${GRANITE_INIT_TEMPLATE:-}" ]; then
    granite init --template "$GRANITE_INIT_TEMPLATE"
  else
    granite init
  fi
fi

if [ "$#" -eq 0 ]; then
  set -- granite mcp --transport http --host 0.0.0.0
elif [ "${1#-}" != "$1" ]; then
  set -- granite mcp --transport http --host 0.0.0.0 "$@"
fi

exec "$@"
