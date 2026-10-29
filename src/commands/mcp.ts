import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { requireVaultRoot, getGraniteDir } from '../core/vault.js';
import { startGraniteMcpHttpServer, startGraniteMcpStdioServer } from '../mcp/server.js';
import type { McpAccessRole } from '../mcp/server.js';
import { GraniteMcpRuntime } from '../mcp/runtime.js';

interface McpCommandOptions {
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
}

// ---- PID / URL file helpers ------------------------------------------------

function pidPath(vaultRoot: string): string {
  return path.join(getGraniteDir(vaultRoot), 'mcp.pid');
}

function urlPath(vaultRoot: string): string {
  return path.join(getGraniteDir(vaultRoot), 'mcp.url');
}

function ensureGraniteDir(vaultRoot: string): void {
  fs.mkdirSync(getGraniteDir(vaultRoot), { recursive: true });
}

function readPid(vaultRoot: string): number | null {
  try {
    const raw = fs.readFileSync(pidPath(vaultRoot), 'utf-8').trim();
    const pid = Number.parseInt(raw, 10);
    if (Number.isNaN(pid)) return null;
    // signal 0 probes liveness without actually sending a signal
    try { process.kill(pid, 0); return pid; } catch { return null; }
  } catch {
    return null;
  }
}

function writeDaemonState(vaultRoot: string, pid: number, url: string): void {
  ensureGraniteDir(vaultRoot);
  fs.writeFileSync(pidPath(vaultRoot), String(pid), 'utf-8');
  fs.writeFileSync(urlPath(vaultRoot), url, 'utf-8');
}

function cleanupFiles(vaultRoot: string): void {
  try { fs.unlinkSync(pidPath(vaultRoot)); } catch {}
  try { fs.unlinkSync(urlPath(vaultRoot)); } catch {}
}

// ---- Commands --------------------------------------------------------------

export async function mcpCommand(options: McpCommandOptions): Promise<void> {
  const transport = parseTransport(options.transport);
  const role = parseMcpRole(options.role);
  const vaultRoot = resolveVaultRoot(options.vault);

  if (options.webApi && transport !== 'http') {
    console.error('--web-api requires --transport http');
    process.exit(1);
  }

  // --background: re-spawn ourselves as a detached child
  if (options.background) {
    if (transport !== 'http') {
      console.error('--background requires --transport http');
      process.exit(1);
    }

    const running = readPid(vaultRoot);
    if (running) {
      console.error(`MCP server already running (PID ${running}). Use "granite mcp stop" first.`);
      process.exit(1);
    }

    // Use env var to detect daemon mode — avoids fragile argv stripping
    const logFile = path.join(getGraniteDir(vaultRoot), 'mcp.log');
    ensureGraniteDir(vaultRoot);
    const fd = fs.openSync(logFile, 'a');

    const child = spawn(process.execPath, process.argv.slice(1), {
      detached: true,
      stdio: ['ignore', fd, fd],
      env: { ...process.env, GRANITE_MCP_DAEMONIZED: '1' },
    });

    child.unref();
    fs.closeSync(fd);

    if (!child.pid) {
      console.error('Failed to start background process');
      process.exit(1);
    }

    writeDaemonState(vaultRoot, child.pid, '(starting...)');
    console.error(`MCP server starting in background (PID ${child.pid})`);
    console.error(`Log: ${logFile}`);
    console.error(`Stop with: granite mcp stop`);
    process.exit(0);
  }

  // In daemon mode, --background flag is still in argv but we skip it via env var
  const isDaemon = process.env.GRANITE_MCP_DAEMONIZED === '1';
  const runtime = new GraniteMcpRuntime(vaultRoot);

  const shutdown = () => {
    if (isDaemon) cleanupFiles(vaultRoot);
    runtime.close();
    process.exit(0);
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  if (transport === 'http') {
    const port = parsePort(options.port);
    const host = options.host ?? '127.0.0.1';
    const authToken = resolveAuthToken(options.authToken);
    const localUrl = `http://${host}:${port}/mcp`;

    startGraniteMcpHttpServer(runtime, {
      host,
      port,
      allowedOrigins: options.allowOrigin ?? [],
      authToken,
      jsonResponse: options.jsonResponse ?? false,
      role,
      webApi: options.webApi ?? false,
    });

    if (isDaemon) writeDaemonState(vaultRoot, process.pid, localUrl);

    return;
  }

  await startGraniteMcpStdioServer(runtime, { role });
}

export function mcpStopCommand(options: { vault?: string }): void {
  const vaultRoot = resolveVaultRoot(options.vault);
  const pid = readPid(vaultRoot);
  if (!pid) {
    console.error('No running MCP server found.');
    process.exit(1);
  }
  process.kill(pid, 'SIGTERM');
  cleanupFiles(vaultRoot);
  console.error(`MCP server stopped (PID ${pid}).`);
}

export function mcpStatusCommand(options: { vault?: string }): void {
  const vaultRoot = resolveVaultRoot(options.vault);
  const pid = readPid(vaultRoot);
  if (!pid) {
    console.error('MCP server is not running.');
    process.exit(1);
  }
  let url = '';
  try { url = fs.readFileSync(urlPath(vaultRoot), 'utf-8').trim(); } catch {}
  console.error(`MCP server is running (PID ${pid})`);
  if (url) console.error(`  Endpoint: ${url}`);
}

function resolveVaultRoot(explicitVault?: string): string {
  const fromEnv = process.env.GRANITE_VAULT;
  if (explicitVault) {
    return path.resolve(explicitVault);
  }
  if (fromEnv) {
    return path.resolve(fromEnv);
  }
  return requireVaultRoot();
}

export function parseTransport(value?: string): 'stdio' | 'http' {
  const transport = value ?? 'stdio';
  if (transport !== 'stdio' && transport !== 'http') {
    throw new Error(`Invalid MCP transport: ${transport}. Expected "stdio" or "http".`);
  }
  return transport;
}

export function parsePort(value?: string): number {
  const raw = (value ?? process.env.MCP_PORT ?? process.env.PORT ?? '3321').trim();
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid MCP port: ${raw}`);
  }

  const parsed = Number.parseInt(raw, 10);
  if (parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid MCP port: ${raw}`);
  }
  return parsed;
}

export function parseMcpRole(value?: string): McpAccessRole {
  const role = value ?? 'write';
  if (role === 'read' || role === 'write') return role;
  throw new Error(`Invalid MCP role: ${role}. Expected "read" or "write".`);
}

export function resolveAuthToken(value?: string): string | undefined {
  const raw = value ?? process.env.GRANITE_MCP_TOKEN;
  if (raw === undefined) return undefined;

  const token = raw.trim();
  if (!token) {
    throw new Error('Invalid MCP auth token: token cannot be empty.');
  }
  return token;
}
