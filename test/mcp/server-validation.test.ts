import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig, writeDefaultConfig } from '../../src/core/config.js';
import { GraniteMcpRuntime } from '../../src/mcp/runtime.js';
import { createGraniteMcpServer } from '../../src/mcp/server.js';

describe('granite MCP server — strict type validation end-to-end', () => {
  let tmpDir: string;
  let runtime: GraniteMcpRuntime;
  let server: ReturnType<typeof createGraniteMcpServer>;
  let client: Client;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-mcp-validate-'));
    writeDefaultConfig(tmpDir);
    const raw = yaml.load(fs.readFileSync(path.join(tmpDir, 'granite.yml'), 'utf-8')) as any;
    raw.note_types.meeting = {
      folder: 'notes/meetings',
      description: 'Meetings with decisions',
      template: '## Summary\n\n## Decisions\n\n## Action items\n',
      line_limit: 300,
      warn_only: false,
      fields: {
        date: { type: 'date', required: true, description: 'Meeting date' },
      },
    };
    fs.writeFileSync(path.join(tmpDir, 'granite.yml'), yaml.dump(raw));
    const config = loadConfig(tmpDir);
    for (const typeConfig of Object.values(config.note_types)) {
      fs.mkdirSync(path.join(tmpDir, typeConfig.folder), { recursive: true });
    }

    runtime = new GraniteMcpRuntime(tmpDir, { indexCheckIntervalMs: 0 });
    server = createGraniteMcpServer(runtime);
    client = new Client({ name: 'granite-validation-client', version: '1.0.0' });
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

  it('rejects granite_capture_knowledge for a strict type when required fields are missing', async () => {
    const result = await client.callTool({
      name: 'granite_capture_knowledge',
      arguments: { author: 'stan',
        title: 'Monka sync',
        type: 'meeting',
        body: '## Summary\n## Decisions\n## Action items\n',
      },
    });
    expect(result.isError).toBe(true);
    const text = result.content?.find((c: any) => c.type === 'text') as { text: string } | undefined;
    expect(text?.text ?? '').toMatch(/missing_required_field/);
  });

  it('accepts granite_capture_knowledge for a strict type when fields are supplied', async () => {
    const result = await client.callTool({
      name: 'granite_capture_knowledge',
      arguments: { author: 'stan',
        title: 'Monka sync',
        type: 'meeting',
        body: '## Summary\n## Decisions\n## Action items\n',
        fields: { date: '2026-04-17' },
      },
    });
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text?: string }>).find(c => c.type === 'text')?.text ?? '';
    expect(text).toContain('2026-04-17');
    expect(text).not.toMatch(/missing_required_field|validation_failed/);
  });

  it('exposes fields input in the granite_capture_knowledge tool schema', async () => {
    const tools = await client.listTools();
    const capture = tools.tools.find(t => t.name === 'granite_capture_knowledge');
    expect(capture).toBeDefined();
    const schemaProps = (capture?.inputSchema as any)?.properties ?? {};
    expect(schemaProps.fields).toBeDefined();
  });

  it('exposes fields input in the granite_revise_note tool schema', async () => {
    const tools = await client.listTools();
    const revise = tools.tools.find(t => t.name === 'granite_revise_note');
    expect(revise).toBeDefined();
    const schemaProps = (revise?.inputSchema as any)?.properties ?? {};
    expect(schemaProps.fields).toBeDefined();
  });
  it.each([undefined, '', 'bad: yaml', 'unknown'])('explains author errors through MCP for %j', async author => {
    const result = await client.callTool({ name: 'granite_capture_knowledge', arguments: { title: 'Rejected', author } });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text?: string }>).map(c => c.text ?? '').join(' ');
    expect(text).toMatch(/Pass author/);
    expect(text).toMatch(/stan, dave, granite/);
    expect(runtime.listNotes()).toEqual([]);
  });

  it('requires documented author input on every note-writing MCP tool', async () => {
    const { tools } = await client.listTools();
    for (const name of ['granite_capture_knowledge', 'granite_revise_note', 'granite_dispose_note', 'granite_import_document']) {
      const tool = tools.find(tool => tool.name === name);
      expect(tool).toBeDefined();
      expect(tool!.inputSchema.required).toContain('author');
      const author = (tool!.inputSchema.properties as Record<string, { description?: string }>).author;
      expect(author.description).toMatch(/stan/);
    }
  });

});
