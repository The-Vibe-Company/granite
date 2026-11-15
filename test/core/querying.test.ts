import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, writeDefaultConfig } from '../../src/core/config.js';
import { getBacklinks } from '../../src/core/backlinks.js';
import { createDatabase, rebuildIndex } from '../../src/core/index-db.js';
import { createNote, findNoteBySlug } from '../../src/core/note.js';
import { searchNotes } from '../../src/core/search.js';
import { suggestLinks } from '../../src/core/suggest.js';
import type { GraniteConfig } from '../../src/core/types.js';

describe('querying helpers', () => {
  let tmpDir: string;
  let config: GraniteConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-querying-'));
    writeDefaultConfig(tmpDir);
    config = loadConfig(tmpDir);

    for (const typeConfig of Object.values(config.note_types)) {
      fs.mkdirSync(path.join(tmpDir, typeConfig.folder), { recursive: true });
    }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns normalized search results with snippet and score', () => {
    createNote(tmpDir, config, 'note', 'Graph Memory', 'A graph memory stores linked ideas.\n', { author: 'stan' });

    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    rebuildIndex(tmpDir, config, db);

    const results = searchNotes(db, 'linked ideas');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      slug: 'graph-memory',
      title: 'Graph Memory',
      type: 'note',
    });
    expect(results[0].snippet).toContain('>>>');
    expect(typeof results[0].score).toBe('number');

    db.close();
  });

  it('returns backlinks sorted by source title', () => {
    createNote(tmpDir, config, 'note', 'Zulu Source', 'Points to [[Target Note]].\n', { author: 'stan' });
    createNote(tmpDir, config, 'note', 'Alpha Source', 'Also points to [[Target Note]].\n', { author: 'stan' });
    createNote(tmpDir, config, 'note', 'Target Note', 'Referenced note.\n', { author: 'stan' });

    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    rebuildIndex(tmpDir, config, db);

    const backlinks = getBacklinks(db, 'target-note');
    expect(backlinks.map(link => link.source_title)).toEqual(['Alpha Source', 'Zulu Source']);

    db.close();
  });

  it('suggests notes mentioned in body and skips existing wikilinks', () => {
    createNote(tmpDir, config, 'note', 'Machine Learning', 'Base concept.\n', { author: 'stan' });
    createNote(tmpDir, config, 'note', 'Large Language Model', 'Alias-heavy concept.\n', { author: 'stan' });

    const llmNotePath = path.join(tmpDir, config.note_types.note.folder, 'large-language-model.md');
    const llmContent = fs.readFileSync(llmNotePath, 'utf-8');
    fs.writeFileSync(
      llmNotePath,
      llmContent.replace('aliases: []', 'aliases:\n  - LLM\n  - foundation model'),
      'utf-8',
    );

    const current = createNote(
      tmpDir,
      config,
      'note',
      'Draft Note',
      [
        'Machine learning appears twice.',
        'Machine Learning enables modern systems.',
        'An LLM can be a foundation model.',
        'There is already a wikilink to [[Machine Learning]].',
      ].join('\n'),
    { author: 'stan' });

    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    rebuildIndex(tmpDir, config, db);

    const refreshedCurrent = findNoteBySlug(tmpDir, config, current.slug);
    expect(refreshedCurrent).not.toBeNull();

    const suggestions = suggestLinks(db, refreshedCurrent!).toSorted(
      (a, b) => a.target_slug.localeCompare(b.target_slug),
    );
    expect(suggestions).toEqual([
      {
        target_slug: 'large-language-model',
        target_title: 'Large Language Model',
        mentions: 2,
      },
    ]);

    db.close();
  });
});
