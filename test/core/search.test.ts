import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import { loadConfig } from '../../src/core/config.js';
import { createNote } from '../../src/core/note.js';
import { createDatabase, rebuildIndex } from '../../src/core/index-db.js';
import { searchNotes } from '../../src/core/search.js';
import type { GraniteConfig } from '../../src/core/types.js';

describe('searchNotes', () => {
  let tmpDir: string;
  let config: GraniteConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-search-'));
    const cfg: GraniteConfig = {
      vault_name: 't', version: 1,
      note_types: {
        note: { folder: 'notes', description: '', template: '', line_limit: 200, warn_only: false },
        meeting: { folder: 'meetings', description: '', template: '', line_limit: 200, warn_only: false },
      },
      defaults: { note_type: 'note', editor: '$EDITOR' },
      index: { auto_rebuild: true },
    };
    fs.writeFileSync(path.join(tmpDir, 'granite.yml'), yaml.dump(cfg));
    fs.mkdirSync(path.join(tmpDir, 'notes'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'meetings'), { recursive: true });
    config = loadConfig(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('OR-joins multiple words and returns matches', () => {
    createNote(tmpDir, config, 'meeting', 'Distillation primer', 'about distillation and fermentation.\n');
    createNote(tmpDir, config, 'note', 'Other', 'unrelated content.\n');

    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    rebuildIndex(tmpDir, config, db);

    const results = searchNotes(db, 'distillation fermentation');
    expect(results).toContainEqual(expect.objectContaining({
      slug: 'distillation-primer',
      type: 'meeting',
    }));
    db.close();
  });

  it('passes through FTS5 operators unchanged', () => {
    createNote(tmpDir, config, 'note', 'Alpha', 'alpha beta gamma.\n');

    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    rebuildIndex(tmpDir, config, db);

    const results = searchNotes(db, 'alpha AND beta');
    expect(results.map(r => r.slug)).toContain('alpha');
    db.close();
  });

  it('returns a single-token query as-is', () => {
    createNote(tmpDir, config, 'note', 'Solo', 'solo content.\n');
    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    rebuildIndex(tmpDir, config, db);
    const results = searchNotes(db, 'solo');
    expect(results.map(r => r.slug)).toContain('solo');
    db.close();
  });

  it('falls back to LIKE when FTS parsing throws', () => {
    createNote(tmpDir, config, 'note', 'Paren', 'text with " symbols.\n');
    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    rebuildIndex(tmpDir, config, db);
    // Quote-only query is invalid FTS5 → triggers fallback
    const results = searchNotes(db, '"');
    expect(Array.isArray(results)).toBe(true);
    expect(results[0]?.type).toBe('note');
    db.close();
  });

  it('widens the ranking pool beyond the returned limit', () => {
    for (let i = 0; i < 6; i++) {
      createNote(tmpDir, config, 'note', `Fermentation Study ${i}`, 'fermentation fermentation fermentation.\n');
    }
    createNote(tmpDir, config, 'note', 'Weak Match', 'a single mention of fermentation here.\n');

    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    rebuildIndex(tmpDir, config, db);

    // A tight pool cannot see the weak match at all.
    const narrow = searchNotes(db, 'fermentation', { limit: 2, candidateLimit: 2 });
    expect(narrow).toHaveLength(2);

    // A wide pool surfaces it, which is what a reranker needs in order to
    // promote a relevant row that BM25 ranked below the final cut.
    const poolRows = db.prepare(
      `SELECT n.slug FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid
       WHERE notes_fts MATCH ? ORDER BY rank LIMIT ?`,
    ).all('fermentation', 20) as Array<{ slug: string }>;

    const widePool = searchNotes(db, 'fermentation', { limit: 2, candidateLimit: 20 });
    expect(widePool).toHaveLength(2);
    expect(poolRows.length).toBeGreaterThan(narrow.length);
    expect(poolRows.map(r => r.slug)).toContain('weak-match');
    db.close();
  });
});
