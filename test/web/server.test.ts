import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, writeDefaultConfig } from '../../src/core/config.js';
import type { GraniteConfig } from '../../src/core/types.js';
import { createApp } from '../../src/web/server.js';

describe('web note creation', () => {
  let tmpDir: string;
  let config: GraniteConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-web-'));
    writeDefaultConfig(tmpDir);
    config = loadConfig(tmpDir);

    for (const typeConfig of Object.values(config.note_types)) {
      fs.mkdirSync(path.join(tmpDir, typeConfig.folder), { recursive: true });
    }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('updates the index immediately after creating a note through the web API', async () => {
    const app = createApp(tmpDir, config);

    const createResponse = await app.request('/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        author: 'stan',
        type: 'note',
        title: 'Web Created Note',
        body: 'Unique web body.\n',
      }),
    });

    expect(createResponse.status).toBe(200);

    const searchResponse = await app.request('/api/search?q=unique');
    const searchPayload = await searchResponse.json() as { results: Array<{ slug: string }> };

    expect(searchPayload.results.some(result => result.slug === 'web-created-note')).toBe(true);
  });

  it('serves graph nodes and resolved links from the graph API', async () => {
    const app = createApp(tmpDir, config);

    const firstResponse = await app.request('/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        author: 'stan',
        type: 'note',
        title: 'Graph Seed',
        body: 'Anchor note.\n',
      }),
    });
    expect(firstResponse.status).toBe(200);

    const secondResponse = await app.request('/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        author: 'stan',
        type: 'note',
        title: 'Graph Leaf',
        body: 'Connects to [[Graph Seed]].\n',
      }),
    });
    expect(secondResponse.status).toBe(200);

    const graphResponse = await app.request('/api/graph');
    expect(graphResponse.status).toBe(200);

    const graphPayload = await graphResponse.json() as {
      nodes: Array<{ slug: string }>;
      edges: Array<{ source: string; target: string }>;
    };

    expect(graphPayload.nodes.some(node => node.slug === 'graph-seed')).toBe(true);
    expect(graphPayload.nodes.some(node => node.slug === 'graph-leaf')).toBe(true);
    expect(graphPayload.edges).toContainEqual({ source: 'graph-leaf', target: 'graph-seed' });
  });
});
