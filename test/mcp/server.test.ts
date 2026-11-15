import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { writeDefaultConfig, loadConfig } from '../../src/core/config.js';
import { createNote } from '../../src/core/note.js';
import type { GraniteConfig } from '../../src/core/types.js';
import { GraniteMcpRuntime } from '../../src/mcp/runtime.js';
import { createGraniteMcpServer, withResponseCleanup } from '../../src/mcp/server.js';
import { createDocxFixture } from '../helpers/document-fixtures.js';

describe('granite MCP server', () => {
  let tmpDir: string;
  let config: GraniteConfig;
  let runtime: GraniteMcpRuntime;
  let server: ReturnType<typeof createGraniteMcpServer>;
  let client: Client;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-mcp-'));
    writeDefaultConfig(tmpDir);
    config = loadConfig(tmpDir);

    for (const typeConfig of Object.values(config.note_types)) {
      fs.mkdirSync(path.join(tmpDir, typeConfig.folder), { recursive: true });
    }

    createNote(tmpDir, config, 'note', 'MCP Note', 'Granite MCP test note.\n', { author: 'stan' });

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
  });

  it('exposes tools, resources, prompts, and instructions', async () => {
    const tools = await client.listTools();
    const resources = await client.listResources();
    const templates = await client.listResourceTemplates();
    const prompts = await client.listPrompts();

    expect(tools.tools.some(tool => tool.name === 'granite_capture_knowledge')).toBe(true);
    expect(tools.tools.some(tool => tool.name === 'granite_extract_document')).toBe(true);
    expect(tools.tools.some(tool => tool.name === 'granite_import_document')).toBe(true);
    expect(tools.tools.some(tool => tool.name === 'granite_understand_note')).toBe(true);
    expect(tools.tools.some(tool => tool.name === 'granite_create_note')).toBe(false);
    expect(tools.tools.some(tool => tool.name === 'granite_plan_garden')).toBe(true);
    expect(tools.tools.some(tool => tool.name === 'granite_adjudicate_garden_opportunity')).toBe(true);
    expect(tools.tools.some(tool => tool.name === 'granite_list_garden_adjudications')).toBe(true);
    expect(resources.resources.some(resource => resource.uri === 'granite://vault/types')).toBe(true);
    expect(templates.resourceTemplates.some(template => template.uriTemplate === 'granite://notes/{slug}')).toBe(true);
    expect(templates.resourceTemplates.some(template => template.uriTemplate === 'granite://assets/{filename}')).toBe(true);
    expect(prompts.prompts.some(prompt => prompt.name === 'granite_refine_note')).toBe(true);
    expect(prompts.prompts.some(prompt => prompt.name === 'granite_compile_topic')).toBe(true);
    expect(prompts.prompts.some(prompt => prompt.name === 'granite_garden_vault')).toBe(false);
    expect(client.getInstructions()).toContain('Knowledge Compilation System');
  });

  it('hides mutating tools and prompts in read-only MCP mode', async () => {
    const readServer = createGraniteMcpServer(runtime, { role: 'read' });
    const readClient = new Client({ name: 'granite-read-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await readServer.connect(serverTransport);
    await readClient.connect(clientTransport);

    try {
      const tools = await readClient.listTools();
      const toolNames = tools.tools.map(tool => tool.name);

      expect(toolNames).toContain('granite_wakeup');
      expect(toolNames).toContain('granite_extract_document');
      expect(toolNames).toContain('granite_understand_note');
      expect(toolNames).not.toContain('granite_capture_knowledge');
      expect(toolNames).not.toContain('granite_import_document');
      expect(toolNames).not.toContain('granite_revise_note');
      expect(toolNames).not.toContain('granite_dispose_note');
      expect(toolNames).not.toContain('granite_adjudicate_garden_opportunity');
      expect(readClient.getInstructions()).toContain('read-only mode');
      expect(readClient.getInstructions()).not.toContain('granite_capture_knowledge');
    } finally {
      await readClient.close();
      await readServer.close();
    }
  });

  it('serves note resources and prompt templates', async () => {
    const resource = await client.readResource({ uri: 'granite://notes/mcp-note' });
    const typeResource = await client.readResource({ uri: 'granite://vault/types' });
    const prompt = await client.getPrompt({
      name: 'granite_compile_topic',
      arguments: { topic: 'MCP' },
    });

    const noteText = resource.contents[0] && 'text' in resource.contents[0] ? resource.contents[0].text : '';
    const typeText = typeResource.contents[0] && 'text' in typeResource.contents[0] ? typeResource.contents[0].text : '';

    expect(noteText).toContain('title: MCP Note');
    expect(typeResource.contents[0] && 'mimeType' in typeResource.contents[0] ? typeResource.contents[0].mimeType : '').toBe('text/markdown');
    expect(typeText).toContain('# Note Types');
    expect(prompt.messages).toHaveLength(1);
  });

  it('captures notes and understands them through the public MCP tools', async () => {
    const created = await client.callTool({
      name: 'granite_capture_knowledge',
      arguments: { author: 'stan',
        title: 'Linked Result',
        type: 'note',
        body: 'This note points to [[MCP Note]].\n',
        source: 'agent',
      },
    });

    const createdText = extractTextContent(created);
    expect(createdText).toContain('# Created Note');
    expect(createdText).toContain('linked-result');
    expect(createdText.trim().startsWith('{')).toBe(false);

    const understood = await client.callTool({
      name: 'granite_understand_note',
      arguments: { slug: 'mcp-note' },
    });

    const understoodText = extractTextContent(understood);
    expect(understoodText).toContain('# Note Context');
    expect(understoodText).toContain('linked-result');
  });

  it('archives notes through granite_dispose_note', async () => {
    const disposed = await client.callTool({
      name: 'granite_dispose_note',
      arguments: { author: 'stan', slug: 'mcp-note' },
    });

    const disposedText = extractTextContent(disposed);
    expect(disposedText).toMatch(/archive/i);
    expect(disposedText).toContain('mcp-note');
  });

  it('imports documents and serves their asset resources through MCP', async () => {
    const inputFile = path.join(tmpDir, 'mcp-source.pdf');
    fs.writeFileSync(inputFile, '%PDF-1.4\nmcp source\n');

    const imported = await client.callTool({
      name: 'granite_import_document',
      arguments: { author: 'stan',
        file_path: inputFile,
        content: 'MCP source content\n\nKey point: preserve the extracted text in the note.',
      },
    });

    const importedText = extractTextContent(imported);
    expect(importedText).toContain('mcp-source');
    expect(importedText).toContain('application/pdf');

    const assetLink = (imported.content as Array<{ type: string; uri?: string; mimeType?: string }>)
      .find((c) => c.type === 'resource_link' && c.mimeType === 'application/pdf');
    expect(assetLink?.uri).toBeDefined();

    const resource = await client.readResource({ uri: assetLink!.uri! });
    const content = resource.contents[0];

    expect(content && 'mimeType' in content ? content.mimeType : '').toBe('application/pdf');
    expect(content && 'blob' in content).toBe(true);
  });

  it('extracts documents through MCP without importing them', async () => {
    const inputFile = path.join(tmpDir, 'mcp-source.docx');
    createDocxFixture(inputFile, ['MCP extraction works']);

    const extracted = await client.callTool({
      name: 'granite_extract_document',
      arguments: {
        file_path: inputFile,
      },
    });

    const extractedText = extractTextContent(extracted);
    expect(extractedText).toContain('# Document Extraction');
    expect(extractedText).toContain('## Raw Text');
    expect(extractedText).toContain('MCP extraction works');
    expect(extractedText).toMatch(/docx/);
    expect(extractedText).toMatch(/mammoth/);
  });

  it('returns wakeup as markdown', async () => {
    const wakeup = await client.callTool({
      name: 'granite_wakeup',
      arguments: {},
    });

    const wakeupText = extractTextContent(wakeup);
    expect(wakeupText).toContain('# Vault Wakeup');
    expect(wakeupText).toContain('## AAAK');
    expect(wakeupText.trim().startsWith('{')).toBe(false);
  });

  it('makes the inbox workflow doc-aware for imported source notes', async () => {
    const inputFile = path.join(tmpDir, 'workflow-source.pdf');
    fs.writeFileSync(inputFile, '%PDF-1.4\nworkflow\n');

    await client.callTool({
      name: 'granite_import_document',
      arguments: { author: 'stan',
        file_path: inputFile,
        content: 'Workflow source content',
      },
    });

    const inboxPrompt = await client.getPrompt({
      name: 'granite_process_inbox',
      arguments: {},
    });

    const inboxMessage = inboxPrompt.messages[0];

    expect(inboxMessage.content.type).toBe('text');
    if (inboxMessage.content.type !== 'text') {
      throw new Error('Expected text content for inbox prompt.');
    }

    expect(inboxMessage.content.text).toContain('workflow-source');
    expect(inboxMessage.content.text).toContain('granite_extract_document');
    expect(inboxMessage.content.text).toContain('imported document attached');
  });

  it('makes compile topic doc-aware for imported source notes', async () => {
    const inputFile = path.join(tmpDir, 'workflow-source.pdf');
    fs.writeFileSync(inputFile, '%PDF-1.4\nworkflow source\n');

    await client.callTool({
      name: 'granite_import_document',
      arguments: { author: 'stan',
        file_path: inputFile,
        content: 'Workflow source content',
        title: 'Workflow Source',
      },
    });

    const prompt = await client.getPrompt({
      name: 'granite_compile_topic',
      arguments: { topic: 'workflow' },
    });

    expect(prompt.messages).toHaveLength(1);
    const message = prompt.messages[0];
    expect(message.content.type).toBe('text');
    if (message.content.type !== 'text') {
      throw new Error('Expected text content for granite_compile_topic prompt.');
    }

    expect(message.content.text).toContain('granite_extract_document');
    expect(message.content.text).toContain('Workflow Source');
    expect(message.content.text).toContain('imported document attached');
  });

  it('renders garden plan markdown with opportunity IDs when any exist', async () => {
    const plan = await client.callTool({
      name: 'granite_plan_garden',
      arguments: {},
    });
    const planText = extractTextContent(plan);
    expect(planText).toContain('# Garden Plan');
    expect(planText).toContain('Operator hint');
    if (!planText.includes('- None')) {
      expect(planText).toMatch(/Opportunity ID/);
    }
  });

  it('renders garden adjudications markdown', async () => {
    const list = await client.callTool({
      name: 'granite_list_garden_adjudications',
      arguments: {},
    });
    const listText = extractTextContent(list);
    expect(listText).toContain('# Garden Adjudications');
    expect(listText).toContain('Active adjudications:');
  });

  it('renders granite_query results with modified timestamps', async () => {
    const queryResult = await client.callTool({
      name: 'granite_query',
      arguments: { type: 'note' },
    });
    const queryText = extractTextContent(queryResult);
    expect(queryText).toContain('# Query Results');
    expect(queryText).toContain('mcp-note');
    expect(queryText).toContain('| title | slug | type | modified');
  });

  it('closes cleanup hooks after an HTTP response body is consumed', async () => {
    let cleanupCount = 0;
    const response = new Response('granite');

    const wrapped = await withResponseCleanup(response, async () => {
      cleanupCount += 1;
    });

    expect(await wrapped.text()).toBe('granite');
    expect(cleanupCount).toBe(1);
  });
});

function extractTextContent(result: Awaited<ReturnType<Client['callTool']>>) {
  const textContent = result.content.find(item => item.type === 'text');
  if (!textContent || textContent.type !== 'text') {
    throw new Error('Tool result did not include text content.');
  }
  return textContent.text;
}
