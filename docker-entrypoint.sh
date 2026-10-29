#!/usr/bin/env sh
set -eu

: "${GRANITE_VAULT:=/vault}"
export GRANITE_VAULT

# Railway's container filesystem is ephemeral. Refuse to create a vault there.
if [ -n "${RAILWAY_PROJECT_ID:-}" ]; then
  : "${GRANITE_MCP_TOKEN:?Set GRANITE_MCP_TOKEN in Railway service variables}"
  : "${TYPESAFE_API_KEY:?Set TYPESAFE_API_KEY in Railway service variables}"
  : "${RAILWAY_VOLUME_MOUNT_PATH:?Attach a Railway volume at /vault before deploying}"
  if [ "$GRANITE_VAULT" != "$RAILWAY_VOLUME_MOUNT_PATH" ]; then
    echo "GRANITE_VAULT must equal RAILWAY_VOLUME_MOUNT_PATH (normally /vault)." >&2
    exit 1
  fi
  export GRANITE_DISABLE_DOCUMENT_PARSING=1
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
