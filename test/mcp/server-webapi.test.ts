import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeDefaultConfig, loadConfig } from '../../src/core/config.js';
import { createNote } from '../../src/core/note.js';
import { GraniteMcpRuntime } from '../../src/mcp/runtime.js';
import { createGraniteMcpHttpApp } from '../../src/mcp/server.js';

const TOKEN = 'test-web-api-token';

describe('MCP HTTP app with --web-api', () => {
  let tmpDir: string;
  let runtime: GraniteMcpRuntime;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-webapi-'));
    writeDefaultConfig(tmpDir);
    const config = loadConfig(tmpDir);
    for (const typeConfig of Object.values(config.note_types)) {
      fs.mkdirSync(path.join(tmpDir, typeConfig.folder), { recursive: true });
    }
    createNote(tmpDir, config, 'note', 'Cloud Note', 'Visible from the web API.\n', { author: 'stan' });
    runtime = new GraniteMcpRuntime(tmpDir, { indexCheckIntervalMs: 0 });
  });

  afterEach(() => {
    runtime.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createApp(webApi: boolean) {
    return createGraniteMcpHttpApp(runtime, {
      host: '0.0.0.0',
      port: 8080,
      authToken: TOKEN,
      webApi,
    });
  }

  it('guards the web API with the same bearer token as /mcp', async () => {
    const app = createApp(true);

    const unauthorized = await app.request('/api/graph');
    expect(unauthorized.status).toBe(401);

    const wrongToken = await app.request('/api/graph', {
      headers: { Authorization: 'Bearer wrong' },
    });
    expect(wrongToken.status).toBe(401);

    const authorized = await app.request('/api/graph', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(authorized.status).toBe(200);
    const payload = await authorized.json() as { nodes: Array<{ slug: string }> };
    expect(payload.nodes.some(node => node.slug === 'cloud-note')).toBe(true);
  });

  it('guards /assets/* behind the bearer token', async () => {
    const app = createApp(true);

    const unauthorized = await app.request('/assets/missing.png');
    expect(unauthorized.status).toBe(401);

    const authorized = await app.request('/assets/missing.png', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(authorized.status).toBe(404); // authenticated, asset just doesn't exist
  });

  it('does not expose the web API without the flag', async () => {
    const app = createApp(false);

    const response = await app.request('/api/graph', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(404);
  });

  it('never mounts the write endpoint', async () => {
    const app = createApp(true);

    const response = await app.request('/api/notes', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'note', title: 'Nope' }),
    });
    expect(response.status).toBe(404);
  });

  it('keeps /health unauthenticated', async () => {
    const app = createApp(true);
    const response = await app.request('/health');
    expect(response.status).toBe(200);
  });
});
