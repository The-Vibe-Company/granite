import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importDocumentCommand } from '../../src/commands/import.js';
import { loadConfig, writeDefaultConfig } from '../../src/core/config.js';
import { parseFrontmatter } from '../../src/core/frontmatter.js';
import type { GraniteConfig } from '../../src/core/types.js';

describe('import command', () => {
  let tmpDir: string;
  let config: GraniteConfig;
  let previousCwd: string;

  beforeEach(() => {
    previousCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-import-'));
    writeDefaultConfig(tmpDir);
    config = loadConfig(tmpDir);

    for (const typeConfig of Object.values(config.note_types)) {
      fs.mkdirSync(path.join(tmpDir, typeConfig.folder), { recursive: true });
    }

    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('refuses to run when document parsing is disabled', () => {
    vi.stubEnv('GRANITE_DISABLE_DOCUMENT_PARSING', 'true');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);

    try {
      expect(() => importDocumentCommand('whatever.pdf', { author: 'stan', content: 'text' })).toThrow('process.exit(1)');
      expect(String(errorSpy.mock.calls[0]?.[0])).toContain('GRANITE_DISABLE_DOCUMENT_PARSING');
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('imports a document as a source note with required content and linked asset', () => {
    const inputFile = path.join(tmpDir, 'attention-is-all-you-need.pdf');
    fs.writeFileSync(inputFile, '%PDF-1.4\nfake\n');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    importDocumentCommand(inputFile, { author: 'stan',
      content: 'Transformer paper excerpt.\n\nKey idea: attention replaces recurrence.',
      json: true,
    });

    const output = logSpy.mock.calls.at(-1)?.[0];
    expect(typeof output).toBe('string');

    const payload = JSON.parse(String(output)) as {
      success: boolean;
      data: {
        slug: string;
        type: string;
        status: string;
        source: string;
        review_state: string;
        asset: { file: string; relative_path: string; resource_uri: string };
      };
    };

    expect(payload.success).toBe(true);
    expect(payload.data.slug).toBe('attention-is-all-you-need');
    expect(payload.data.type).toBe('source');
    expect(payload.data.status).toBe('inbox');
    expect(payload.data.source).toBe('extraction');
    expect(payload.data.review_state).toBe('draft');
    expect(payload.data.asset.relative_path).toBe(`assets/${payload.data.asset.file}`);
    expect(payload.data.asset.resource_uri).toBe(`granite://assets/${encodeURIComponent(payload.data.asset.file)}`);

    const notePath = path.join(tmpDir, config.note_types.source.folder, 'attention-is-all-you-need.md');
    const raw = fs.readFileSync(notePath, 'utf-8');
    const { frontmatter, body } = parseFrontmatter(raw);

    expect(frontmatter.document_file).toBe(payload.data.asset.file);
    expect(frontmatter.document_path).toBe(payload.data.asset.relative_path);
    expect(frontmatter.document_mime).toBe('application/pdf');
    expect(typeof frontmatter.document_sha256).toBe('string');
    expect(frontmatter.document_resource_uri).toBe(payload.data.asset.resource_uri);
    expect(body).toContain('## Document');
    expect(body).toContain('## Content');
    expect(body).toContain('Transformer paper excerpt.');
    expect(body).toContain(`[${payload.data.asset.file}](assets/${payload.data.asset.file})`);
  });
});
