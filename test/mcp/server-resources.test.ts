import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig, writeDefaultConfig } from '../../src/core/config.js';
import { createNote } from '../../src/core/note.js';
import { GraniteMcpRuntime } from '../../src/mcp/runtime.js';
import { createGraniteMcpServer, type McpAccessRole } from '../../src/mcp/server.js';

const templateCases = {
  'granite://notes/{slug}': ['granite://notes/mcp-note', 'granite://notes/%6Dcp-note'],
  'granite://assets/{filename}': [
    `granite://assets/${encodeURIComponent('rapport été #1.txt')}`,
    `granite://assets/${encodeURIComponent('source %.pdf')}`,
  ],
};
const resourceCases = ['granite://vault/types', 'granite://vault/other/../types', 'granite://notes/other/../mcp-note', 'granite://assets/rapport été %231.txt', ...Object.values(templateCases).flat()];

describe.each<McpAccessRole>(['read', 'write'])('MCP resource tools (%s role)', role => {
  let tmpDir: string;
  let runtime: GraniteMcpRuntime;
  let server: ReturnType<typeof createGraniteMcpServer>;
  let client: Client;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-resource-tools-'));
    writeDefaultConfig(tmpDir);
    const config = loadConfig(tmpDir);
    config.note_types.note.body_sections = ['Summary', 'Details'];
    config.note_types.note.fields = { project: { type: 'text', required: true } };
    config.note_types.note.indexed_fields = ['project'];
    fs.writeFileSync(path.join(tmpDir, 'granite.yml'), yaml.dump(config));
    for (const type of Object.values(config.note_types)) {
      fs.mkdirSync(path.join(tmpDir, type.folder), { recursive: true });
    }
    createNote(tmpDir, config, 'note', 'MCP Note', '## Summary\nResource parity\n\n## Details\n', { extraFrontmatter: { project: 'Granite' } });
    fs.mkdirSync(path.join(tmpDir, 'assets'));
    fs.writeFileSync(path.join(tmpDir, 'assets', 'rapport été #1.txt'), 'Texte UTF-8 : été\n');
    fs.writeFileSync(path.join(tmpDir, 'assets', 'source %.pdf'), Buffer.from([0x25, 0x50, 0x44, 0x46, 0, 0xff]));

    runtime = new GraniteMcpRuntime(tmpDir, { indexCheckIntervalMs: 0 });
    server = createGraniteMcpServer(runtime, { role });
    client = new Client({ name: 'resource-tools-test', version: '1.0.0' });
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

  it('covers every advertised resource and template', async () => {
    const resources = await client.listResources();
    const templates = await client.listResourceTemplates();
    expect(resources.resources.map(resource => resource.uri).sort()).toEqual(['granite://vault/types']);
    expect(templates.resourceTemplates.map(template => template.uriTemplate).sort()).toEqual(Object.keys(templateCases).sort());
  });

  it('returns the complete vault type contract unchanged through granite_vault_types', async () => {
    const resource = await client.readResource({ uri: 'granite://vault/types' });
    const tool = await client.callTool({ name: 'granite_vault_types', arguments: {} });
    expect(tool.isError).toBeFalsy();
    expect(tool.content).toEqual(resource.contents.map(resource => ({ type: 'resource', resource })));
    const text = resource.contents[0];
    expect(text && 'text' in text ? text.text : '').toContain('### Body sections\n`Summary` → `Details`');
    expect(text && 'text' in text ? text.text : '').toContain('| `project` | `text` | yes |');
    expect(text && 'text' in text ? text.text : '').toContain('### indexed_fields\n`project`');
  });

  it.each(resourceCases)('returns exactly the resource contents for %s', async uri => {
    const resource = await client.readResource({ uri });
    const tool = await client.callTool({ name: 'granite_read_resource', arguments: { uri } });
    expect(tool.isError).toBeFalsy();
    // Includes URI, MIME type, exact markdown/text, and base64 bytes for binary assets.
    expect(tool.content).toEqual(resource.contents.map(resource => ({ type: 'resource', resource })));
  });

  it.each(['granite://vault/unknown', 'granite://other/mcp-note', 'not a URI', 'granite://notes/', 'granite://notes/%E0%A4%A', 'granite://assets/%ZZ'])('explains supported URIs/templates for unknown URI %s', async uri => {
    const tool = await client.callTool({ name: 'granite_read_resource', arguments: { uri } });
    expect(tool.isError).toBe(true);
    expect(tool.content).toEqual([{ type: 'text', text: `Unknown Granite resource URI: ${uri}. Supported URIs/templates: granite://vault/types, granite://notes/{slug}, granite://assets/{filename}` }]);
  });

  it('preserves missing-resource errors for a recognized template', async () => {
    const uri = 'granite://assets/missing.txt';
    await expect(client.readResource({ uri })).rejects.toThrow('Asset not found: missing.txt');
    const tool = await client.callTool({ name: 'granite_read_resource', arguments: { uri } });
    expect(tool.isError).toBe(true);
    expect(tool.content).toEqual([{ type: 'text', text: 'Asset not found: missing.txt' }]);
  });

  it('advertises both tools as read-only and points to them from wakeup', async () => {
    const { tools } = await client.listTools();
    for (const name of ['granite_vault_types', 'granite_read_resource']) {
      const tool = tools.find(tool => tool.name === name);
      expect(tool?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
      expect(tools.find(tool => tool.name === 'granite_wakeup')?.description).toContain(name);
    }
  });
});
