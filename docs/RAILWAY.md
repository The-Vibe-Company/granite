# Private Granite on Railway

Run one personal Granite vault in your own Railway project, accessed through
an authenticated, read/write MCP endpoint. The cloud volume is the source of
truth: your computer does not need to be running, and no local vault or sync
process is required by MCP clients.

## Deploy with one button

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/uTwCwu)

Choose your Railway workspace, enter your own `TYPESAFE_API_KEY`, then deploy.
The template creates the Granite service, a `/vault` volume, an HTTPS endpoint,
and a fresh random MCP bearer token in your account. Retrieve
`GRANITE_MCP_TOKEN` from your service variables and connect your agent to
`https://<your-domain>/mcp` with `Authorization: Bearer <your-token>`.

The template follows this repository's `main` branch.

Service configuration lives in the Railway template. No `railway.json` or
`railway.toml` is committed; each user can adjust their own Railway settings.
Only the TypeSafe key requires user input. No maintainer credentials or vault
contents are included.

## Alternative: deploy directly from GitHub

1. Create a Railway service from this repository (or your fork). Railway detects
   and builds the included Dockerfile. Leave the start command
   unset so Docker's entrypoint initializes the vault and starts MCP.
2. Attach a **persistent volume at `/vault`** to that service before deploying.
   Railway rejects Dockerfile `VOLUME` instructions before the build starts, so
   storage must be attached in Railway rather than declared in the Dockerfile.
3. Set these service variables in Railway:

   | Variable | Value |
   | --- | --- |
   | `GRANITE_MCP_TOKEN` | A strong random secret, e.g. 32 random bytes from a password manager |
   | `TYPESAFE_API_KEY` | Your TypeSafe key; Jev is required by Granite |
   | `GRANITE_INIT_TEMPLATE` | Optional, e.g. `founder-os`; used only for a new vault |

   `/vault` is the image's default `GRANITE_VAULT`. If using another mount path,
   set `GRANITE_VAULT` to that path or a directory inside it. Railway supplies
   `RAILWAY_VOLUME_MOUNT_PATH`; do not set it manually to bypass the check.
   Missing secrets or a vault outside the real volume path cause startup to fail,
   including paths that escape through symlinks.
4. Deploy, then generate a Railway HTTPS domain for the service. The server
   listens on Railway's `PORT`, on `0.0.0.0`. Leave `MCP_PORT` unset unless you
   deliberately configure the same target port in Railway networking.
5. Connect your agent to `https://<your-domain>/mcp`, sending
   `Authorization: Bearer <your-token>` on every request. Use the client's
   secret/environment configuration; do not commit the token.

For a direct GitHub deployment, set the healthcheck to `/health`, the restart
policy to **On Failure** with 3 retries, and keep one replica in Railway. The
shared template already carries these settings.
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

Use `granite migrate railway` with an authenticated Railway CLI (the directory
transfer contract was verified with CLI 5.62.1). Deploy the current Granite image
first: the migration checks the **running entrypoint** for descendant-vault support,
not just a version variable. The CLI also requires your local `TYPESAFE_API_KEY`,
as other Granite commands do. No local Jev request is made by migration.

```sh
# Read-only preflight is the default. Use explicit IDs from Railway.
granite migrate railway --vault ~/.granite \
  --project PROJECT_ID --service SERVICE_ID --environment ENVIRONMENT_ID

# After backing up both vaults and stopping ALL local and remote writers:
granite migrate railway --vault ~/.granite \
  --project PROJECT_ID --service SERVICE_ID --environment ENVIRONMENT_ID \
  --apply --writers-stopped
```

Stop clients, sync/watch processes, daemons and automation that write either vault.
Keep the destination service running for the read-only SSH capability check; stop
its **writers**, not its container. The acknowledgment is a maintenance-window
promise, not a distributed lock. Do not resume writers during migration.

The command resolves the attached volume by the running service/volume names and
mount path, then passes its explicit volume ID to Railway's file commands. It
requires a persistent volume, MCP token and TypeSafe key. Sealed Railway secrets
are supported: their values remain private and runtime startup checks they exist.
Provider output is never printed, including failures, because it may hold secrets.

Migration copies `granite.yml`, configured note folders, `assets/` and
`attachments/`, preserving bytes, relative paths and note IDs. For another
attachment folder, repeat `--include documents` (paths must be inside the vault).
A note's `document_path` must be in the snapshot. Arbitrary Markdown links are not
crawled; include any custom attachment roots explicitly and verify representative
links afterward. Hidden files, local sync/credential state, indexes, logs, PID
files and known key/secret filenames are excluded. Symlinks, special files and
unsafe paths in selected content are rejected. This is not a secret-content
scanner: keep credentials out of notes and attachment content.

On apply, the command:

1. Creates a private local snapshot and hashes every selected file.
2. Uploads to a unique `/.granite/migrations/<uuid>` directory on the volume,
   without overwrite. This hidden directory is excluded from normal vault scans
   even when the previous vault is the volume root.
3. Downloads to a new temporary directory and compares every file and SHA-256 hash,
   then confirms the local source and destination configuration have not changed.
4. Sets `GRANITE_VAULT` to the verified directory, submitting a Railway redeploy.

The previous remote vault and local source are preserved. A rollback command using
the previous `GRANITE_VAULT` is printed **before any upload**. Save it: setting that
variable back redeploys the preserved vault. Stop writers before rollback as well;
changes made to the new vault after activation are not merged into the old copy.
A failed transfer leaves an inactive staging directory for inspection; it never
automatically deletes remote files. If activation reports an uncertain outcome,
inspect Railway's current `GRANITE_VAULT` and deployment before retrying or rolling
back. Local temporary copies are removed when the command exits normally.

**Activation submitted does not mean live verification passed.** Verify `/health`,
authenticated `granite_wakeup`, representative notes and attachments, a temporary
capture/revision, and persistence after restart before switching clients. Keep the
local copy read-only until verification is complete. Avoid two writable copies.
The CLI does not provision services, change client configurations, or enable backups.

## Backups and operations

Enable Railway volume backups and test restoring one before retiring the local
backup. Keep an independent export as well: a persistent volume is not a backup.
Railway currently does not support replicas with volumes and may briefly stop
the service during redeploys. Keep this deployment at one replica.

The shared template provisions the service, volume, HTTP proxy and variables.
Backup schedules still need to be enabled on each deployed volume. `granite deploy`
continues to manage Fly.io Sprites; Railway deployments use this repository and
Railway's own deployment controls.

References: [Railway volumes](https://docs.railway.com/volumes),
[backups](https://docs.railway.com/volumes/backups),
[creating templates](https://docs.railway.com/templates/create).
