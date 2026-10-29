import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeDefaultConfig, loadConfig } from '../../src/core/config.js';
import { createNote } from '../../src/core/note.js';
import type { GraniteConfig } from '../../src/core/types.js';
import { GraniteMcpRuntime } from '../../src/mcp/runtime.js';

describe('runtime graph regressions', () => {
  let tmpDir: string;
  let config: GraniteConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-runtime-graph-'));
    writeDefaultConfig(tmpDir);
    config = loadConfig(tmpDir);
    for (const typeConfig of Object.values(config.note_types)) {
      fs.mkdirSync(path.join(tmpDir, typeConfig.folder), { recursive: true });
    }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('counts one inbound source note when that note mentions the target repeatedly', () => {
    createNote(tmpDir, config, 'note', 'Target', 'The target entity.\n');
    createNote(
      tmpDir,
      config,
      'note',
      'Source',
      'First context for [[target]].\nSecond context for [[target]].\n',
    );

    const runtime = new GraniteMcpRuntime(tmpDir, { indexCheckIntervalMs: 0 });
    try {
      const understanding = runtime.understandNote('target');
      expect(understanding.backlinks).toHaveLength(1);
      expect(understanding.backlinks[0].source_slug).toBe('source');
      expect(understanding.backlinks[0].context).toContain('First context');
      expect(understanding.graph_role.inbound_links).toBe(1);
      expect(understanding.graph_role.total_connections).toBe(1);
    } finally {
      runtime.close();
    }
  });
});
