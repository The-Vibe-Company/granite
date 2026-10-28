# Deploying Granite to the cloud

For a private read/write MCP instance on **Railway**, see [the Railway guide](RAILWAY.md). It uses the included Dockerfile and `railway.json`, with a persistent volume in your own account.

`granite deploy` provisions a personal serverless Granite on [Fly.io Sprites](https://sprites.dev): a real persistent filesystem, an MCP endpoint that wakes on request (100–500 ms warm) and sleeps when idle. Idle cost ≈ storage only — a markdown vault is a few MB, so cents per month.

There is no central admin, no Granite cloud account, no relay: the sprite is **yours**, on your Sprites account, paid by you directly.

## Quick start

Commands on this page assume the CLI is installed globally (`npm install -g granite-mem`).

```bash
export SPRITES_TOKEN=…   # from sprites.dev
granite deploy
```

Or store the Sprites API token once in a user-scoped credentials file:

```bash
granite deploy login --token <sprites-token>
```

On a shared machine, prefer `SPRITES_TOKEN=<token> granite deploy login` — an inline environment variable stays out of `ps` output, unlike a `--token` argument. Note it still lands in shell history unless you prefix the command with a space (with `HISTCONTROL=ignorespace` or zsh's `HIST_IGNORE_SPACE`) or load the token from a password manager.

That writes `~/.granite/config/sprites.json` (mode `0600` where supported). It works on macOS, Linux, and Windows via the user's home directory. Commands resolve credentials in this order: `--token`, `SPRITES_TOKEN`, then the stored file. Remove it with `granite deploy logout`.

Shell examples on this page assume a POSIX shell (macOS, Linux, WSL, Git Bash). On Windows PowerShell, set the environment variable with `$env:SPRITES_TOKEN = "…"` instead of `export`.

Deploy prints an MCP URL + bearer token ready to paste into Claude Code or Cursor:

```bash
claude mcp add --transport http granite https://<your-sprite>.sprites.app/mcp \
  --header "Authorization: Bearer <token>"
```

## Managing instances

Manage instances from any machine after `deploy login`, or with `SPRITES_TOKEN`:

```bash
granite deploy work            # a second instance (own vault, own token, own URL)
granite deploy list            # all instances: version, health, MCP URL
granite deploy status --show-token   # prints the live MCP bearer token — don't paste it in public channels or CI logs
granite deploy                 # re-run = upgrade that instance to your CLI version
granite deploy --all           # bulk remote update of every instance
granite deploy destroy work    # permanent — asks for confirmation
```

Useful flags on `granite deploy`:

- `--template <name>` — initialize the cloud vault from a template (e.g. `founder-os`)
- `--rotate-token` — generate a new MCP bearer token for the instance
- `--force` — adopt an existing sprite that was not created by `granite deploy`

## Browsing cloud vaults from the local UI

```bash
SPRITES_TOKEN=… granite serve
```

`granite serve` discovers your managed sprites using `SPRITES_TOKEN` or the stored `~/.granite/config/sprites.json` token. It keeps MCP bearer tokens on the local server and proxies read-only graph/search/note requests to the selected cloud instance. Use `granite serve --no-cloud` to browse only the local vault.

## Notes and limitations

- Document parsing (PDF/DOCX/XLSX/PPTX) is **disabled in cloud deployments** (`GRANITE_DISABLE_DOCUMENT_PARSING=1`). Extract and import documents on your local Granite.
- Cloud instances expose MCP plus an authenticated read-only web API for the local UI switcher; note creation in the web UI remains local-only.
- The Sprites API token is local user configuration at `~/.granite/config/sprites.json`; it is never written to vault notes and is excluded from Granite sync manifests.
- The vault lives at `/home/sprite/.granite` on the sprite, on durable object-storage-backed disk. There is no export/backup command in v1 — treat the sprite as the single copy for now.

## Advanced: run the HTTP MCP server yourself

Granite can expose the MCP server over HTTP anywhere you can run Node. When binding outside localhost, a bearer token is required:

```bash
export GRANITE_MCP_TOKEN="$(openssl rand -hex 32)"
granite mcp --vault ~/.granite \
  --transport http \
  --host 0.0.0.0 \
  --port 3321 \
  --web-api
```

Clients must send the token on every MCP request:

```bash
claude mcp add --transport http granite https://granite.example.com/mcp \
  --header "Authorization: Bearer $GRANITE_MCP_TOKEN"
```

A generic `Dockerfile` is included for self-hosting on your own infra (build it yourself; no public image is published). The `/health` endpoint is unauthenticated for platform checks.

Security notes:

- Do not expose `granite serve` or the web UI port `4321` on the public internet; the web UI is local-only and has no authentication.
- If `--web-api` is enabled on the HTTP MCP server, `/api/*` and `/assets/*` are guarded by the same bearer token as `/mcp`.
