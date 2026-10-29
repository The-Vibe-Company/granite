import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { writeDefaultConfig, loadConfig } from '../../src/core/config.js';
import { GraniteMcpRuntime } from '../../src/mcp/runtime.js';
import { createGraniteMcpServer } from '../../src/mcp/server.js';

describe('MCP server with document parsing disabled', () => {
  let tmpDir: string;
  let runtime: GraniteMcpRuntime;
  let server: ReturnType<typeof createGraniteMcpServer>;
  let client: Client;

  beforeEach(async () => {
    vi.stubEnv('GRANITE_DISABLE_DOCUMENT_PARSING', '1');

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-mcp-nodocs-'));
    writeDefaultConfig(tmpDir);
    const config = loadConfig(tmpDir);
    for (const typeConfig of Object.values(config.note_types)) {
      fs.mkdirSync(path.join(tmpDir, typeConfig.folder), { recursive: true });
    }

    runtime = new GraniteMcpRuntime(tmpDir, { indexCheckIntervalMs: 0 });
    server = createGraniteMcpServer(runtime);
    client = new Client({ name: 'granite-test-client', version: '1.0.0' });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    runtime.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('does not expose the document parsing tools', async () => {
    const tools = await client.listTools();
    const toolNames = tools.tools.map(tool => tool.name);

    expect(toolNames).not.toContain('granite_extract_document');
    expect(toolNames).not.toContain('granite_import_document');
    // The rest of the surface is intact.
    expect(toolNames).toContain('granite_wakeup');
    expect(toolNames).toContain('granite_vault_types');
    expect(toolNames).toContain('granite_read_resource');
    expect(toolNames).toContain('granite_capture_knowledge');
    expect(toolNames).toContain('granite_revise_note');
  });

  it('omits document parsing from the server instructions', async () => {
    const instructions = client.getInstructions() ?? '';

    expect(instructions).not.toContain('granite_extract_document');
    expect(instructions).not.toContain('granite_import_document');
    expect(instructions).toContain('Document parsing is disabled in this deployment');
  });

  it('omits granite_extract_document from prompt guidance', async () => {
    const prompt = await client.getPrompt({ name: 'granite_process_inbox', arguments: {} });
    const text = prompt.messages.map(message => (message.content as { text?: string }).text ?? '').join('\n');

    expect(text).not.toContain('granite_extract_document');
  });
});
