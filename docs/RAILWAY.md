# Private Granite on Railway

Run one personal Granite vault in your own Railway project, accessed through
an authenticated, read/write MCP endpoint. The cloud volume is the source of
truth: your computer does not need to be running, and no local vault or sync
process is required by MCP clients.

## Deploy from GitHub

1. Create a Railway service from this repository (or your fork). Railway reads
   `railway.json` and builds the included Dockerfile. Leave the start command
   unset so Docker's entrypoint initializes the vault and starts MCP.
2. Attach a **persistent volume at `/vault`** to that service before deploying.
   The Docker `VOLUME` instruction does not provision Railway storage.
3. Set these service variables in Railway:

   | Variable | Value |
   | --- | --- |
   | `GRANITE_MCP_TOKEN` | A strong random secret, e.g. 32 random bytes from a password manager |
   | `TYPESAFE_API_KEY` | Your TypeSafe key; Jev is required by Granite |
   | `GRANITE_INIT_TEMPLATE` | Optional, e.g. `founder-os`; used only for a new vault |

   `/vault` is the image's default `GRANITE_VAULT`. If using another mount path,
   set `GRANITE_VAULT` to that exact path. Railway supplies
   `RAILWAY_VOLUME_MOUNT_PATH`; do not set it manually to bypass the check.
   Missing secrets or a missing/mismatched volume cause startup to fail.
4. Deploy, then generate a Railway HTTPS domain for the service. The server
   listens on Railway's `PORT`, on `0.0.0.0`. Leave `MCP_PORT` unset unless you
   deliberately configure the same target port in Railway networking.
5. Connect your agent to `https://<your-domain>/mcp`, sending
   `Authorization: Bearer <your-token>` on every request. Use the client's
   secret/environment configuration; do not commit the token.

`railway.json` configures `/health`, a bounded restart policy, and one replica.
The container initializes a new vault only when `granite.yml` is absent and
reuses an existing vault on restart. Do not override the startup command with
`granite init` or a background daemon.

The CLI port precedence is `--port`, `MCP_PORT`, `PORT`, then `3321`.

## Access model

This is a dedicated single-owner instance. Anyone holding the bearer token has
read/write access; give it only to your own trusted agents. The URL is reachable
on the internet, but vault access requires the token. This is not OAuth login or
multi-user access control. Clients must support custom bearer authentication.
Rotate the token in Railway and redeploy, then update clients.

Only MCP and the non-sensitive `/health` endpoint are exposed by default. The
unauthenticated local web UI is not started. Railway startup disables server-side
document parsing: agents extract documents themselves and submit structured
knowledge through MCP. Jev requests still go to TypeSafe; private hosting does
not mean all processing stays inside Railway.

## Verify before switching clients

- `/health` returns HTTP 200 once the MCP runtime has initialized.
- An MCP request without a token, or with the wrong token, returns HTTP 401.
- With the token, call `granite_wakeup`, capture a temporary note, read it through
  `granite://notes/<slug>`, and revise it through `granite_revise_note`.
- Restart/redeploy the service and read the revised note again. Archive the
  temporary note through `granite_dispose_note` when finished.

The repository's `test/deployment/railway.test.ts` exercises the real container
entrypoint and CLI on a temporary filesystem, including auth, Railway `PORT`,
read/write MCP and persistence across process restart. It does not provision a
Railway service or replace the live volume check above.

## Move an existing vault

Treat this as a storage migration, not re-ingestion. Stop all local writers,
back up the vault, and stop the destination service while restoring. Transfer
`granite.yml`, the configured note folders, and referenced attachments to the
Railway volume using Railway's volume tools. Preserve the paths and IDs. Do not
copy local credentials, PID files, or logs; the SQLite search index can be
rebuilt from Markdown. Never put the vault or credentials in the image or Git.

Start the service, verify representative notes and attachments through MCP,
then switch every agent to the remote URL. Keep the local copy as a read-only
rollback backup until verification is complete. Avoid two writable copies.

## Backups and operations

Enable Railway volume backups and test restoring one before retiring the local
backup. Keep an independent export as well: a persistent volume is not a backup.
Railway currently does not support replicas with volumes and may briefly stop
the service during redeploys. Keep this deployment at one replica.

The deployment config does not create volumes, domains, secrets or backup
schedules; these are project resources configured in Railway. `granite deploy`
continues to manage Fly.io Sprites; Railway deployments use this repository and
Railway's own deployment controls.

References: [Railway volumes](https://docs.railway.com/volumes),
[backups](https://docs.railway.com/volumes/backups),
[config as code](https://docs.railway.com/config-as-code).
