import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
let tmp: string;
let env: NodeJS.ProcessEnv;
let child: ChildProcess | undefined;
let client: Client | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-railway-'));
  const vault = path.join(tmp, 'vault');
  fs.mkdirSync(vault);
  // Run the real CLI through the same entrypoint used by Docker, without Docker.
  fs.writeFileSync(path.join(tmp, 'granite'), '#!/bin/sh\nexec "$NODE_BINARY" --import tsx "$GRANITE_CLI" "$@"\n', { mode: 0o755 });
  env = {
    ...process.env, PATH: `${tmp}:${process.env.PATH}`, NODE_BINARY: process.execPath,
    GRANITE_CLI: path.join(root, 'src/index.ts'), GRANITE_VAULT: vault,
    RAILWAY_PROJECT_ID: 'test-project', RAILWAY_VOLUME_MOUNT_PATH: vault,
    GRANITE_MCP_TOKEN: 'test-token-not-a-credential', TYPESAFE_API_KEY: 'test-key-not-a-credential',
  };
  delete env.MCP_PORT;
  delete env.GRANITE_INIT_TEMPLATE;
  delete env.GRANITE_MCP_DAEMONIZED;
});

async function stop() {
  await client?.close();
  client = undefined;
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  }
  child = undefined;
}

afterEach(async () => {
  await stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

it.each(['GRANITE_MCP_TOKEN', 'TYPESAFE_API_KEY', 'RAILWAY_VOLUME_MOUNT_PATH'])(
  'refuses Railway startup without %s before initializing a vault', key => {
    delete env[key];
    const result = spawnSync('sh', ['docker-entrypoint.sh'], { cwd: root, env, encoding: 'utf8', timeout: 3000 });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(key);
    expect(fs.existsSync(path.join(env.GRANITE_VAULT!, 'granite.yml'))).toBe(false);
  },
);

it('refuses to put the vault outside the Railway volume', () => {
  env.RAILWAY_VOLUME_MOUNT_PATH = path.join(tmp, 'other-volume');
  fs.mkdirSync(env.RAILWAY_VOLUME_MOUNT_PATH);
  const result = spawnSync('sh', ['docker-entrypoint.sh'], { cwd: root, env, encoding: 'utf8', timeout: 3000 });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('GRANITE_VAULT must be inside');
  expect(fs.existsSync(path.join(env.GRANITE_VAULT!, 'granite.yml'))).toBe(false);
});

it('serves authenticated read/write MCP on PORT and retains changes across restart', async () => {
  env.GRANITE_VAULT = path.join(env.RAILWAY_VOLUME_MOUNT_PATH!, '.granite/migrations/active');
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  env.PORT = String((socket.address() as net.AddressInfo).port);
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const base = `http://127.0.0.1:${env.PORT}`;

  async function start() {
    let output = '';
    child = spawn('sh', ['docker-entrypoint.sh'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout!.on('data', data => { output += data; });
    child.stderr!.on('data', data => { output += data; });
    let healthy = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(`Container entrypoint exited: ${output}`);
      try { healthy = (await fetch(`${base}/health`)).ok; } catch { /* starting */ }
      if (healthy) break;
      await delay(100);
    }
    expect(healthy, output).toBe(true);
    client = new Client({ name: 'railway-test', version: '1.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${env.GRANITE_MCP_TOKEN}` } },
    }));
  }

  await start();
  for (const headers of [{}, { Authorization: 'Bearer wrong-token' }]) {
    expect((await fetch(`${base}/mcp`, { method: 'POST', headers })).status).toBe(401);
  }
  expect((await fetch(`${base}/api/notes`)).status).toBe(404);
  const tools = await client!.listTools();
  expect(tools.tools.some(tool => tool.name === 'granite_import_document')).toBe(false);
  // First note in an empty vault has no link candidates, so no Jev network call.
  const created = await client!.callTool({ name: 'granite_capture_knowledge', arguments: {
    title: 'Cloud persistence', type: 'note', body: 'Created over remote MCP.', source: 'agent',
  } });
  expect(created.isError).not.toBe(true);
  const revised = await client!.callTool({ name: 'granite_revise_note', arguments: {
    slug: 'cloud-persistence', append: 'Updated over remote MCP.', source: 'agent',
  } });
  expect(revised.isError).not.toBe(true);
  await stop();
  await start();
  const result = await client!.readResource({ uri: 'granite://notes/cloud-persistence' });
  const text = result.contents.map(item => 'text' in item ? item.text : '').join('\n');
  expect(text).toContain('Created over remote MCP.');
  expect(text).toContain('Updated over remote MCP.');
}, 30000);

it('accepts a descendant vault and rejects a symlink escape before initialization', () => {
  env.GRANITE_VAULT = path.join(env.RAILWAY_VOLUME_MOUNT_PATH!, '.granite/migrations/new');
  const accepted = spawnSync('sh', ['docker-entrypoint.sh', '--granite-migration-capability'], { cwd: root, env, encoding: 'utf8' });
  expect(accepted.status).toBe(0);
  expect(fs.existsSync(env.GRANITE_VAULT)).toBe(false);
  fs.mkdirSync(path.join(tmp, 'outside'));
  fs.symlinkSync(path.join(tmp, 'outside'), path.join(env.RAILWAY_VOLUME_MOUNT_PATH!, 'escape'));
  env.GRANITE_VAULT = path.join(env.RAILWAY_VOLUME_MOUNT_PATH!, 'escape/new');
  const rejected = spawnSync('sh', ['docker-entrypoint.sh'], { cwd: root, env, encoding: 'utf8' });
  expect(rejected.status).not.toBe(0);
  expect(rejected.stderr).toContain('GRANITE_VAULT must be inside');
  expect(fs.existsSync(path.join(tmp, 'outside/new'))).toBe(false);
});
