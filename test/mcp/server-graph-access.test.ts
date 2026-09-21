import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { writeDefaultConfig, loadConfig } from '../../src/core/config.js';
import { createNote } from '../../src/core/note.js';
import { GraniteMcpRuntime } from '../../src/mcp/runtime.js';
import { createGraniteMcpServer } from '../../src/mcp/server.js';

/**
 * The graph access tools are driven through the MCP protocol, on a real vault on disk.
 *
 * `about` and `pool` were CLI-only when they first shipped, so an agent could not reach
 * them at all. Testing them at the core level would not have caught that: these tests call
 * the tools the way a client does, which is the only shape that proves the surface exists.
 */
describe('MCP graph access tools', () => {
  let tmpDir: string;
  let runtime: GraniteMcpRuntime;
  let server: ReturnType<typeof createGraniteMcpServer>;
  let client: Client;

  const textOf = (result: unknown): string => {
    const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
    return content.find(part => part.type === 'text')?.text ?? '';
  };

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-mcp-about-'));
    writeDefaultConfig(tmpDir);
    // The vault types used by real Granite vaults; the default config only ships the
    // knowledge-first four, and these tools are about entities and the notes that cite them.
    const configPath = path.join(tmpDir, 'granite.yml');
    const raw = yaml.load(fs.readFileSync(configPath, 'utf-8')) as Record<string, any>;
    raw.note_types.organization = { folder: 'notes/organizations', description: 'Organizations' };
    raw.note_types.person = { folder: 'notes/people', description: 'People' };
    raw.note_types.meeting = { folder: 'notes/meetings', description: 'Meetings' };
    fs.writeFileSync(configPath, yaml.dump(raw));

    const config = loadConfig(tmpDir);
    for (const typeConfig of Object.values(config.note_types)) {
      fs.mkdirSync(path.join(tmpDir, typeConfig.folder), { recursive: true });
    }

    createNote(tmpDir, config, 'organization', 'Monka.care', 'Monka.care operates in France.\n');
    // `createNote` writes the body as an argument, so the wikilinks that make the graph are
    // appended here. A note the vault does not link is not an entity reference, which is the
    // whole input these tools read.
    const link = (type: string, title: string, body: string) => {
      const note = createNote(tmpDir, config, type, title, `${body}\n`);
      fs.appendFileSync(note.filepath, `See [[monka-care]].\n`);
      return note;
    };
    link('meeting', 'Kickoff', 'Kickoff call with Monka.care about hosting.');
    link('meeting', 'Follow-up', 'Follow-up with Monka.care on pricing.');
    link('person', 'Etienne Rubi', 'Etienne Rubi sponsors Monka.care.');

    runtime = new GraniteMcpRuntime(tmpDir, { indexCheckIntervalMs: 0 });
    server = createGraniteMcpServer(runtime);
    client = new Client({ name: 'granite-about-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    runtime.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exposes both tools to a client', async () => {
    const tools = (await client.listTools()).tools.map(tool => tool.name);
    expect(tools).toContain('granite_about');
    expect(tools).toContain('granite_pool');
  });

  it('describes the graph access tools as read-only', async () => {
    const tools = (await client.listTools()).tools;
    for (const name of ['granite_about', 'granite_pool']) {
      const tool = tools.find(candidate => candidate.name === name);
      expect(tool?.annotations?.readOnlyHint, `${name} should be read-only`).toBe(true);
    }
  });

  it('documents every input a caller can pass', async () => {
    const tools = (await client.listTools()).tools;
    const about = tools.find(tool => tool.name === 'granite_about');
    const pool = tools.find(tool => tool.name === 'granite_pool');
    expect(Object.keys((about?.inputSchema as { properties?: object }).properties ?? {}).sort())
      .toEqual(['direction', 'slug', 'types']);
    expect(Object.keys((pool?.inputSchema as { properties?: object }).properties ?? {}).sort())
      .toEqual(['anchor', 'depth', 'limit', 'sentences']);
  });

  it('reads an entity through its references', async () => {
    const result = await client.callTool({ name: 'granite_about', arguments: { slug: 'monka-care' } });
    const text = textOf(result);
    expect(result.isError).toBeFalsy();
    expect(text).toContain('# Monka.care');
    expect(text).toContain('## Referenced by — meeting (2)');
    expect(text).toContain('## Referenced by — person (1)');
    expect(text).toContain('3 note(s) link here');
    // The context that explains *why* the note points here travels with the reference.
    expect(text).toContain('See [[monka-care]].');
  });

  it('narrows to the requested types and reports counts for what it returned', async () => {
    const result = await client.callTool({
      name: 'granite_about',
      arguments: { slug: 'monka-care', types: ['meeting'] },
    });
    const text = textOf(result);
    expect(text).toContain('## Referenced by — meeting (2)');
    expect(text).not.toContain('## Referenced by — person');
    // Counts describe the filtered view, not the whole entity.
    expect(text).toContain('2 note(s) link here');
  });

  it('does not claim an entity is unreferenced when only the filter is empty', async () => {
    const result = await client.callTool({
      name: 'granite_about',
      arguments: { slug: 'monka-care', types: ['source'] },
    });
    const text = textOf(result);
    expect(text).not.toContain('Nothing links to this note');
    expect(text).toContain('No source note references this one');
  });

  it('honours the direction argument', async () => {
    const incoming = textOf(await client.callTool({
      name: 'granite_about',
      arguments: { slug: 'monka-care', direction: 'incoming' },
    }));
    expect(incoming).toContain('## Referenced by');
    expect(incoming).not.toContain('## References');

    const outgoing = textOf(await client.callTool({
      name: 'granite_about',
      arguments: { slug: 'monka-care', direction: 'outgoing' },
    }));
    expect(outgoing).not.toContain('## Referenced by');
  });

  it('emits a bounded candidate pool ordered by graph distance', async () => {
    const result = await client.callTool({ name: 'granite_pool', arguments: { anchor: 'monka-care' } });
    const text = textOf(result);
    expect(result.isError).toBeFalsy();
    expect(text).toContain('# Candidate pool around Monka.care');
    expect(text).toContain('## [1]');
    // The judge boundary is stated, because this tool never decides anything.
    expect(text).toContain('Nothing is judged here');
  });

  it('returns titles only when sentences are set to zero', async () => {
    const result = await client.callTool({
      name: 'granite_pool',
      arguments: { anchor: 'monka-care', sentences: 0 },
    });
    const text = textOf(result);
    // Sentence lines are bulleted under a candidate; with none requested there are none.
    const bulletCount = text.split('\n').filter(line => line.startsWith('- ')).length;
    expect(bulletCount).toBe(0);
  });

  it('respects the candidate limit', async () => {
    const text = textOf(await client.callTool({
      name: 'granite_pool',
      arguments: { anchor: 'monka-care', limit: 2 },
    }));
    const candidates = text.split('\n').filter(line => line.startsWith('## [')).length;
    expect(candidates).toBe(2);
  });

  it('reports a clear error for a slug the vault does not have', async () => {
    const about = await client.callTool({ name: 'granite_about', arguments: { slug: 'no-such-note' } });
    expect(about.isError).toBe(true);
    const pool = await client.callTool({ name: 'granite_pool', arguments: { anchor: 'no-such-note' } });
    expect(pool.isError).toBe(true);
  });

  it('returns the pool as structure, not only as prose', async () => {
    // The deterministic half exists to feed the semantic half: a judge is handed this pool.
    // A caller forced to re-parse markdown would be re-deriving what this tool hands over.
    const result = await client.callTool({ name: 'granite_pool', arguments: { anchor: 'monka-care' } });
    const pool = (result as { structuredContent?: Record<string, unknown> }).structuredContent;
    expect(pool).toBeDefined();
    expect(typeof pool?.anchor).toBe('string');
    expect(typeof pool?.reachable).toBe('number');
    const candidates = pool?.candidates as Array<Record<string, unknown>>;
    expect(Array.isArray(candidates)).toBe(true);
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(typeof candidate.slug).toBe('string');
      expect(typeof candidate.title).toBe('string');
      expect(typeof candidate.distance).toBe('number');
      expect(Array.isArray(candidate.sentences)).toBe(true);
    }
    // The prose is still there for a model to read.
    expect(textOf(result)).toContain('# Candidate pool around');
  });

  it('returns the entity as structure with contexts and both counts', async () => {
    const result = await client.callTool({
      name: 'granite_about',
      arguments: { slug: 'monka-care', types: ['meeting'] },
    });
    const entity = (result as { structuredContent?: Record<string, unknown> }).structuredContent;
    expect(entity).toBeDefined();
    expect(entity?.counts).toEqual({ incoming: 2, outgoing: 0 });
    // The unfiltered totals travel too, so a reader can tell an empty filter from an
    // entity nothing points at.
    expect(entity?.unfiltered_counts).toEqual({ incoming: 3, outgoing: 0 });
    const incoming = entity?.incoming as Record<string, Array<{ contexts: string[] }>>;
    expect(Object.keys(incoming)).toEqual(['meeting']);
    expect(incoming.meeting[0].contexts.length).toBeGreaterThan(0);
    expect(entity?.filtered_by).toEqual(['meeting']);
  });

  it('declares an output schema for both tools', async () => {
    const tools = (await client.listTools()).tools;
    for (const name of ['granite_about', 'granite_pool']) {
      const tool = tools.find(candidate => candidate.name === name);
      expect(tool?.outputSchema, `${name} should declare an output schema`).toBeDefined();
    }
  });
});
