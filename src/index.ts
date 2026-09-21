import { Command, InvalidArgumentError } from 'commander';
import { assertJevConfigured } from './mcp/judge.js';
import { initVault } from './commands/init.js';
import { newNote } from './commands/new.js';
import { addNote } from './commands/add.js';
import { openNote } from './commands/open.js';
import { showCommand } from './commands/show.js';
import { searchCommand } from './commands/search.js';
import { factsCommand } from './commands/facts.js';
import { entitiesCommand } from './commands/entities.js';
import { backlinksCommand } from './commands/backlinks.js';
import { suggestLinksCommand } from './commands/suggest-links.js';
import { recommendCommand } from './commands/recommend.js';
import { doctorCommand } from './commands/doctor.js';
import { serveCommand } from './commands/serve.js';
import { typesCommand } from './commands/types.js';
import { listCommand } from './commands/list.js';
import { editCommand } from './commands/edit.js';
import { statusCommand } from './commands/status.js';
import { mcpCommand, mcpStopCommand, mcpStatusCommand, parseTransport } from './commands/mcp.js';
import {
  daemonCommand,
  daemonStartCommand,
  daemonStopCommand,
  daemonStatusCommand,
  daemonLogsCommand,
} from './commands/daemon.js';
import { wakeupCommand } from './commands/wakeup.js';
import {
  deployCommand,
  deployDestroyCommand,
  deployLoginCommand,
  deployListCommand,
  deployLogoutCommand,
  deployStatusCommand,
} from './commands/deploy.js';
import { attachCommand } from './commands/attach.js';
import { extractDocumentCommand } from './commands/extract.js';
import { importDocumentCommand } from './commands/import.js';
import {
  syncAccessGrantCommand,
  syncAccessListCommand,
  syncAccessRevokeCommand,
  syncConfigCommand,
  syncPullCommand,
  syncPushCommand,
  syncRemoteAddCommand,
  syncRemoteListCommand,
  syncRemoteRemoveCommand,
  syncRunCommand,
  syncServeCommand,
  syncStatusCommand,
  syncWatchCommand,
} from './commands/sync.js';
import { GRANITE_VERSION } from './version.js';

const program = new Command();

program
  .name('granite')
  .description('Granite — a local-first knowledge compiler. capture → compile → query → output → lint')
  .version(GRANITE_VERSION);

// ─── Setup ────────────────────────────────────────────────────────────

program
  .command('init')
  .description('Create a new vault and start the knowledge loop')
  .option('--template <name>', 'Start from a template (e.g. founder-os)')
  .action((options: { template?: string }) => {
    initVault(undefined, { template: options.template });
  });

program
  .command('status')
  .description('See where your vault stands and what to do next')
  .option('--json', 'Output as JSON')
  .action((options: { json?: boolean }) => {
    statusCommand(options);
  });

// ─── Capture ──────────────────────────────────────────────────────────

program
  .command('new')
  .description('Create a structured note — search first to avoid duplicates')
  .argument('<title>', 'Note title')
  .option('-t, --type <type>', 'Note type (note, source, synthesis, output)')
  .option('--source <source>', 'Who created it (human, agent, extraction)')
  .option('--status <status>', 'Lifecycle state (inbox, active, archived)')
  .option('--review-state <state>', 'Editorial state (draft, reviewed, locked)')
  .option('--durability <durability>', 'Knowledge permanence (canonical, working, ephemeral)')
  .option('--derived-from <refs>', 'Provenance: slugs this note derives from (comma-separated)')
  .option('--json', 'Output as JSON (agent-friendly)')
  .action((title: string, options: { type?: string; source?: string; status?: string; reviewState?: string; durability?: string; derivedFrom?: string; json?: boolean }) => {
    newNote(title, options);
  });

program
  .command('add')
  .description('Quick-capture raw text into the vault — the fastest way to get something in')
  .argument('[text]', 'Note text (or pipe via stdin)')
  .option('--json', 'Output as JSON (agent-friendly)')
  .action(async (text: string | undefined, options: { json?: boolean }) => {
    await addNote(text, options);
  });

// ─── Query ────────────────────────────────────────────────────────────

program
  .command('list')
  .alias('ls')
  .description('Browse the vault — filter by type, status, source, or date')
  .option('-t, --type <type>', 'Filter by note type')
  .option('-s, --status <status>', 'Filter by status (inbox, active, archived)')
  .option('--source <source>', 'Filter by source (human, agent, extraction)')
  .option('--since <date>', 'Only notes modified since (YYYY-MM-DD)')
  .option('--json [fields]', 'Output as JSON; optionally select fields (e.g. --json slug,title,type)')
  .action((options: { type?: string; status?: string; source?: string; since?: string; json?: boolean | string }) => {
    listCommand(options);
  });

program
  .command('show')
  .alias('cat')
  .description('Read a note in full — frontmatter, body, and metadata')
  .argument('<slug>', 'Note slug')
  .option('--json', 'Output as JSON (agent-friendly)')
  .option('--body', 'Output body only (for piping)')
  .action((slug: string, options: { json?: boolean; body?: boolean }) => {
    showCommand(slug, options);
  });

program
  .command('search')
  .description('Research a topic across the vault — use before creating to avoid duplicates')
  .argument('<query>', 'Search query')
  .option('--json', 'Output as JSON (agent-friendly)')
  .option('--limit <n>', 'Maximum results to return (default 20)', (v) => parseInt(v, 10))
  .option('--candidates <n>', 'Size of the ranking pool before the final cut (widens recall for reranking)', (v) => parseInt(v, 10))
  .action((query: string, options: { json?: boolean; limit?: number; candidates?: number }) => {
    searchCommand(query, options);
  });

program
  .command('facts')
  .description('Read the fact ledger — current state, retirements and contradictions')
  .option('--json', 'Output as JSON (agent-friendly)')
  .option('--write', 'Read fact proposals as JSON on stdin and commit the ones that pass')
  .option('--dry-run', 'With --write, plan the writes without creating anything')
  .option('--contradictions', 'Only report facts that disagree')
  .option('--superseded', 'Only report facts retired by the recency rule')
  .option('--subject <name>', 'Current state of one subject')
  .option('--relation <name>', 'Narrow --subject to one relation')
  .action((options: { json?: boolean; write?: boolean; dryRun?: boolean; contradictions?: boolean; superseded?: boolean; subject?: string; relation?: string }) => {
    factsCommand(options);
  });

program
  .command('entities')
  .description('Find notes that may describe the same thing — candidates, never auto-merged')
  .option('--json', 'Output as JSON (agent-friendly)')
  .option('--review', 'Only show candidates that need a human decision')
  .option('--type <types>', 'Restrict to comma-separated note types')
  .action((options: { json?: boolean; review?: boolean; type?: string }) => {
    entitiesCommand({
      json: options.json,
      review: options.review,
      types: options.type ? options.type.split(',').map(t => t.trim()).filter(Boolean) : undefined,
    });
  });

// ─── Compile ──────────────────────────────────────────────────────────

program
  .command('edit')
  .description('Refine a note — append, rewrite, promote status, add tags and links')
  .argument('<slug>', 'Note slug')
  .option('--body <text>', 'Replace the note body')
  .option('--append <text>', 'Append text to the note body')
  .option('--title <title>', 'Update the note title')
  .option('--tag <tags>', 'Add tags (comma-separated)')
  .option('--alias <aliases>', 'Add aliases (comma-separated)')
  .option('--status <status>', 'Set status (inbox, active, archived)')
  .option('--source <source>', 'Set source (human, agent, extraction)')
  .option('--review-state <state>', 'Set review state (draft, reviewed, locked)')
  .option('--durability <durability>', 'Set durability (canonical, working, ephemeral)')
  .option('--derived-from <refs>', 'Set derived_from references (comma-separated slugs)')
  .action((slug: string, options: { body?: string; append?: string; title?: string; tag?: string; alias?: string; status?: string; source?: string; reviewState?: string; durability?: string; derivedFrom?: string }) => {
    editCommand(slug, options);
  });

program
  .command('open')
  .description('Open a note in your editor')
  .argument('<slug>', 'Note slug')
  .action((slug: string) => {
    openNote(slug);
  });

program
  .command('backlinks')
  .description("See a note's role in the graph — who links here and why")
  .argument('<slug>', 'Note slug')
  .option('--json', 'Output as JSON (agent-friendly)')
  .action((slug: string, options: { json?: boolean }) => {
    backlinksCommand(slug, options);
  });

program
  .command('suggest-links')
  .description('Find unlinked mentions — strengthen the graph by adding missed [[wikilinks]]')
  .argument('<slug>', 'Note slug')
  .option('--json', 'Output as JSON (agent-friendly)')
  .option('--limit <n>', 'Maximum suggestions to return (default 20)', (v) => parseInt(v, 10))
  .action((slug: string, options: { json?: boolean; limit?: number }) => {
    suggestLinksCommand(slug, options);
  });

program
  .command('recommend')
  .description('The heart of the compile loop — what to link, tag, and write next')
  .argument('<slug>', 'Note slug')
  .option('--json', 'Output as JSON (agent-friendly)')
  .action((slug: string, options: { json?: boolean }) => {
    recommendCommand(slug, options);
  });

// ─── Lint ─────────────────────────────────────────────────────────────

program
  .command('doctor')
  .description('Health-check the vault — broken links, missing fields, line limit violations')
  .option('--json', 'Output as JSON')
  .action((options: { json?: boolean }) => {
    doctorCommand(options);
  });

program
  .command('types')
  .description('See the note types and the natural flow: source → note → synthesis → output')
  .action(() => {
    typesCommand();
  });

program
  .command('attach <file>')
  .description('Attach a file (image, video, PDF) to the vault and get markdown embed syntax')
  .option('--slug <slug>', 'Note slug to suggest appending to')
  .option('--json', 'Output as JSON')
  .action((file: string, options: { slug?: string; json?: boolean }) => {
    attachCommand(file, options);
  });

program
  .command('extract <file>')
  .description('Extract raw text from a local document without importing it. Does not clean or summarize the document.')
  .option('--json', 'Output as JSON')
  .action(async (file: string, options: { json?: boolean }) => {
    await extractDocumentCommand(file, options);
  });

program
  .command('import <file>')
  .description('Import a document as a source note plus linked asset, with required caller-provided content. Does not read or clean the document.')
  .requiredOption('--content <content>', 'Caller-provided document text to store in the source note')
  .option('--title <title>', 'Explicit note title. Defaults to a title derived from the filename')
  .option('--tag <tags>', 'Add tags immediately (comma-separated)')
  .option('--alias <aliases>', 'Add aliases immediately (comma-separated)')
  .option('--json', 'Output as JSON')
  .action((file: string, options: { content: string; title?: string; tag?: string; alias?: string; json?: boolean }) => {
    importDocumentCommand(file, options);
  });

program
  .command('wakeup')
  .description('Generate a compressed AAAK snapshot of the vault for LLM context loading')
  .option('--json', 'Output as JSON (includes structured data + AAAK)')
  .action((options: { json?: boolean }) => {
    wakeupCommand(options);
  });

// ─── Serve ────────────────────────────────────────────────────────────

program
  .command('serve')
  .description('Start the local web UI — browse local and cloud vaults, search, and visualize the knowledge graph')
  .option('-p, --port <port>', 'Port number', '4321')
  .option('--no-cloud', 'Skip cloud instance discovery even when Sprites credentials are available')
  .action(async (options: { port: string; cloud?: boolean }) => {
    await serveCommand(options);
  });

const mcpCmd = program
  .command('mcp')
  .description('Start Granite as an MCP server')
  .option('--vault <path>', 'Vault root. Defaults to the current Granite vault or $GRANITE_VAULT')
  .option('--transport <transport>', 'Transport to use: stdio or http', parseTransportOption, 'stdio')
  .option('--host <host>', 'Host for HTTP transport', '127.0.0.1')
  .option('--port <port>', 'Port for HTTP transport', '3321')
  .option('--allow-origin <origin>', 'Allow an HTTP Origin for browser-based HTTP clients', collectValues, [])
  .option('--auth-token <token>', 'Bearer token required for HTTP MCP requests. Defaults to $GRANITE_MCP_TOKEN')
  .option('--json-response', 'Prefer JSON HTTP responses instead of SSE streams')
  .option('--background', 'Run MCP server as a background daemon')
  .option('--role <role>', 'MCP access role: read or write', 'write')
  .option('--web-api', 'Also expose the read-only vault web API (requires --transport http)')
  .action(async (options: {
    vault?: string;
    transport?: 'stdio' | 'http';
    host?: string;
    port?: string;
    allowOrigin?: string[];
    authToken?: string;
    jsonResponse?: boolean;
    background?: boolean;
    role?: string;
    webApi?: boolean;
  }) => {
    await mcpCommand(options);
  });

mcpCmd
  .command('stop')
  .description('Stop a background MCP server')
  .option('--vault <path>', 'Vault root')
  .action((options: { vault?: string }) => {
    mcpStopCommand(options);
  });

mcpCmd
  .command('status')
  .description('Show status of background MCP server')
  .option('--vault <path>', 'Vault root')
  .action((options: { vault?: string }) => {
    mcpStatusCommand(options);
  });

// ─── Deploy ────────────────────────────────────────────────────────────
// One-command serverless Granite on Fly.io Sprites. The sprite is the source
// of truth for instances; the optional Sprites API credential is user-scoped.

const deployCmd = program
  .command('deploy')
  .description('Deploy a personal serverless Granite (MCP over HTTP) to Fly.io Sprites')
  .argument('[name]', 'Instance name (each instance is its own sprite + vault)', undefined)
  .option('--token <token>', 'Sprites API token. Defaults to $SPRITES_TOKEN or ~/.granite/config/sprites.json')
  .option('--template <name>', 'Vault template used on first deploy (e.g. founder-os)')
  .option('--rotate-token', 'Generate a new MCP bearer token for this instance')
  .option('--force', 'Adopt an existing sprite that was not created by granite deploy')
  .option('--all', 'Reconcile every managed instance (bulk remote update)')
  .option('--json', 'Output as JSON')
  .action(async (name: string | undefined, options: { token?: string; template?: string; rotateToken?: boolean; force?: boolean; all?: boolean; json?: boolean }) => {
    await deployCommand(name, options);
  });

deployCmd
  .command('login')
  .description('Store a Sprites API token in ~/.granite/config/sprites.json')
  .option('--token <token>', 'Sprites API token. Defaults to $SPRITES_TOKEN')
  .action((options: { token?: string }) => {
    deployLoginCommand(options);
  });

deployCmd
  .command('logout')
  .description('Remove the stored Sprites API token')
  .action(() => {
    deployLogoutCommand();
  });

// Options placed after the subcommand (e.g. `deploy destroy x --force`) are
// captured by the parent `deploy` command's identically-named options — merge
// parent options into each subcommand's.
deployCmd
  .command('list')
  .alias('ls')
  .description('List deployed Granite instances (version, health, MCP URL)')
  .option('--token <token>', 'Sprites API token. Defaults to $SPRITES_TOKEN or ~/.granite/config/sprites.json')
  .option('--json', 'Output as JSON')
  .action(async (options: { token?: string; json?: boolean }) => {
    await deployListCommand({ ...deployCmd.opts(), ...options });
  });

deployCmd
  .command('status')
  .description('Show details for a deployed instance')
  .argument('[name]', 'Instance name')
  .option('--token <token>', 'Sprites API token. Defaults to $SPRITES_TOKEN or ~/.granite/config/sprites.json')
  .option('--show-token', 'Include the MCP bearer token in the output')
  .option('--json', 'Output as JSON')
  .action(async (name: string | undefined, options: { token?: string; showToken?: boolean; json?: boolean }) => {
    await deployStatusCommand(name, { ...deployCmd.opts(), ...options });
  });

deployCmd
  .command('destroy')
  .description('Permanently delete a deployed instance and its cloud vault')
  .argument('[name]', 'Instance name')
  .option('--token <token>', 'Sprites API token. Defaults to $SPRITES_TOKEN or ~/.granite/config/sprites.json')
  .option('--force', 'Skip the confirmation prompt')
  .action(async (name: string | undefined, options: { token?: string; force?: boolean }) => {
    await deployDestroyCommand(name, { ...deployCmd.opts(), ...options });
  });

// ─── Daemon ────────────────────────────────────────────────────────────
// One background service exposing both MCP (HTTP) and the web UI.

const daemonCmd = program
  .command('daemon')
  .description('Run Granite as a background service (MCP + web UI in one process)')
  .option('--vault <path>', 'Vault root. Defaults to the current Granite vault or $GRANITE_VAULT')
  .option('--host <host>', 'Host both servers bind to', '127.0.0.1')
  .option('--mcp-port <port>', 'MCP HTTP port', '3321')
  .option('--web-port <port>', 'Web UI port', '4321')
  .action(async (options) => {
    await daemonCommand(options);
  });

daemonCmd
  .command('start')
  .description('Start the daemon in the background')
  .option('--vault <path>', 'Vault root')
  .option('--host <host>', 'Host both servers bind to', '127.0.0.1')
  .option('--mcp-port <port>', 'MCP HTTP port', '3321')
  .option('--web-port <port>', 'Web UI port', '4321')
  .action((options) => {
    daemonStartCommand(options);
  });

daemonCmd
  .command('stop')
  .description('Stop the background daemon')
  .option('--vault <path>', 'Vault root')
  .action((options: { vault?: string }) => {
    daemonStopCommand(options);
  });

daemonCmd
  .command('status')
  .description('Show status of the background daemon')
  .option('--vault <path>', 'Vault root')
  .action((options: { vault?: string }) => {
    daemonStatusCommand(options);
  });

daemonCmd
  .command('logs')
  .description('Tail the daemon log file')
  .option('--vault <path>', 'Vault root')
  .option('-n, --lines <count>', 'Number of tail lines', '100')
  .action((options: { vault?: string; lines?: string }) => {
    daemonLogsCommand(options);
  });

// ─── Sync ─────────────────────────────────────────────────────────────
// Direct machine-to-machine vault sync over LAN/Tailscale/private DNS.

const syncCmd = program
  .command('sync')
  .description('Sync a vault directly with another machine over LAN, Tailscale, or private DNS');

syncCmd
  .command('status')
  .description('Show local sync identity, token, policy, and remotes')
  .option('--vault <path>', 'Vault root')
  .option('--json', 'Output as JSON')
  .action((options: { vault?: string; json?: boolean }) => {
    syncStatusCommand(options);
  });

syncCmd
  .command('config')
  .description('Configure conflict resolution for this vault')
  .option('--vault <path>', 'Vault root')
  .option('--policy <policy>', 'Conflict policy: manual or primary-wins')
  .option('--primary-device <device_id>', 'Device that wins conflicts when policy is primary-wins')
  .option('--primary-this-device', 'Make this machine the primary device')
  .option('--json', 'Output as JSON')
  .action((options: {
    vault?: string;
    policy?: string;
    primaryDevice?: string;
    primaryThisDevice?: boolean;
    json?: boolean;
  }) => {
    syncConfigCommand(options);
  });

const syncRemoteCmd = syncCmd
  .command('remote')
  .description('Manage direct sync remotes');

syncRemoteCmd
  .command('list')
  .alias('ls')
  .description('List configured sync remotes')
  .option('--vault <path>', 'Vault root')
  .option('--json', 'Output as JSON')
  .action((options: { vault?: string; json?: boolean }) => {
    syncRemoteListCommand(options);
  });

syncRemoteCmd
  .command('add')
  .description('Add a remote by IP, Tailscale DNS name, or private domain')
  .argument('<name-or-address>', 'Remote name, or address when address is omitted')
  .argument('[address]', 'Remote address, e.g. http://100.x.y.z:8765')
  .option('--vault <path>', 'Vault root')
  .option('--port <port>', 'Port to add when the address has no port', '8765')
  .option('--token <token>', 'Remote sync token')
  .option('--json', 'Output as JSON')
  .action((nameOrAddress: string, address: string | undefined, options: {
    vault?: string;
    port?: string;
    token?: string;
    json?: boolean;
  }) => {
    syncRemoteAddCommand(nameOrAddress, address, options);
  });

syncRemoteCmd
  .command('remove')
  .alias('rm')
  .description('Remove a sync remote')
  .argument('<name>', 'Remote name')
  .option('--vault <path>', 'Vault root')
  .option('--json', 'Output as JSON')
  .action((name: string, options: { vault?: string; json?: boolean }) => {
    syncRemoteRemoveCommand(name, options);
  });

const syncAccessCmd = syncCmd
  .command('access')
  .description('Manage read/write sync access grants');

syncAccessCmd
  .command('list')
  .alias('ls')
  .description('List sync access grants without revealing full tokens')
  .option('--vault <path>', 'Vault root')
  .option('--json', 'Output as JSON')
  .action((options: { vault?: string; json?: boolean }) => {
    syncAccessListCommand(options);
  });

syncAccessCmd
  .command('grant')
  .description('Create or replace a named sync access grant')
  .argument('<name>', 'Grant name, e.g. ipad or teammate-alice')
  .option('--vault <path>', 'Vault root')
  .option('--role <role>', 'Access role: read or write', 'read')
  .option('--json', 'Output as JSON')
  .action((name: string, options: { vault?: string; role?: string; json?: boolean }) => {
    syncAccessGrantCommand(name, options);
  });

syncAccessCmd
  .command('revoke')
  .description('Revoke a named sync access grant')
  .argument('<name>', 'Grant name')
  .option('--vault <path>', 'Vault root')
  .option('--json', 'Output as JSON')
  .action((name: string, options: { vault?: string; json?: boolean }) => {
    syncAccessRevokeCommand(name, options);
  });

syncCmd
  .command('serve')
  .description('Serve this vault for direct sync from another machine')
  .option('--vault <path>', 'Vault root')
  .option('--host <host>', 'Host to bind to', '0.0.0.0')
  .option('--port <port>', 'Port to listen on', '8765')
  .action((options: { vault?: string; host?: string; port?: string }) => {
    syncServeCommand(options);
  });

syncCmd
  .command('pull')
  .description('Pull changes from a direct sync remote')
  .argument('<remote>', 'Remote name')
  .option('--vault <path>', 'Vault root')
  .option('--token <token>', 'Override remote token')
  .option('--json', 'Output as JSON')
  .action(async (remote: string, options: { vault?: string; token?: string; json?: boolean }) => {
    await syncPullCommand(remote, options);
  });

syncCmd
  .command('push')
  .description('Push changes to a direct sync remote')
  .argument('<remote>', 'Remote name')
  .option('--vault <path>', 'Vault root')
  .option('--token <token>', 'Override remote token')
  .option('--json', 'Output as JSON')
  .action(async (remote: string, options: { vault?: string; token?: string; json?: boolean }) => {
    await syncPushCommand(remote, options);
  });

syncCmd
  .command('run')
  .description('Pull then push changes with a direct sync remote')
  .argument('<remote>', 'Remote name')
  .option('--vault <path>', 'Vault root')
  .option('--token <token>', 'Override remote token')
  .option('--json', 'Output as JSON')
  .action(async (remote: string, options: { vault?: string; token?: string; json?: boolean }) => {
    await syncRunCommand(remote, options);
  });

syncCmd
  .command('watch')
  .description('Continuously run direct sync with a remote')
  .argument('<remote>', 'Remote name')
  .option('--vault <path>', 'Vault root')
  .option('--interval <seconds>', 'Seconds between sync runs', '30')
  .option('--direction <direction>', 'Watch direction: pull or run', 'run')
  .action(async (remote: string, options: { vault?: string; interval?: string; direction?: string }) => {
    await syncWatchCommand(remote, options);
  });

// Jev is required, so no command runs without it. `--help`/`--version` still work, because
// refusing to explain itself would be useless.
const JEV_EXEMPT_COMMANDS = new Set(['help']);
program.hook('preAction', (_thisCommand, actionCommand) => {
  if (JEV_EXEMPT_COMMANDS.has(actionCommand.name())) return;
  assertJevConfigured();
});

try {
  await program.parseAsync();
} catch (error) {
  // A missing credential is a configuration mistake, not a crash. Print the sentence and
  // exit; a stack trace here buries the one line the user needs.
  if (error instanceof Error && error.name === 'JevUnavailableError') {
    console.error(`error: ${error.message}`);
    process.exit(1);
  }
  throw error;
}

function collectValues(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseTransportOption(value: string): 'stdio' | 'http' {
  try {
    return parseTransport(value);
  } catch (error) {
    throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
  }
}
