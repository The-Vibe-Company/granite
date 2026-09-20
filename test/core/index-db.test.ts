import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase, ensureIndex, rebuildIndex } from '../../src/core/index-db.js';
import { createNote } from '../../src/core/note.js';
import { writeDefaultConfig, loadConfig } from '../../src/core/config.js';
import { searchNotes } from '../../src/core/search.js';
import { getBacklinks } from '../../src/core/backlinks.js';
import type { GraniteConfig } from '../../src/core/types.js';

describe('index-db', () => {
  let tmpDir: string;
  let config: GraniteConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-idx-'));
    writeDefaultConfig(tmpDir);
    config = loadConfig(tmpDir);
    for (const tc of Object.values(config.note_types)) {
      fs.mkdirSync(path.join(tmpDir, tc.folder), { recursive: true });
    }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates database with correct tables', () => {
    const dbPath = path.join(tmpDir, '.granite', 'index.db');
    const db = createDatabase(dbPath);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    const names = tables.map(t => t.name);
    expect(names).toContain('notes');
    expect(names).toContain('links');
    expect(names).toContain('meta');
    db.close();
  });

  it('indexes notes and makes them searchable', () => {
    createNote(tmpDir, config, 'note', 'Machine Learning', 'ML is about training models on data.\n');
    createNote(tmpDir, config, 'note', 'Neural Networks', 'Neural nets are a type of [[Machine Learning]] model.\n');

    const dbPath = path.join(tmpDir, '.granite', 'index.db');
    const db = createDatabase(dbPath);
    rebuildIndex(tmpDir, config, db);

    // Check notes indexed
    const count = db.prepare('SELECT COUNT(*) as c FROM notes').get() as { c: number };
    expect(count.c).toBe(2);

    // Check FTS search works
    const results = searchNotes(db, 'training models');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].slug).toBe('machine-learning');

    db.close();
  });

  it('indexes links between notes', () => {
    createNote(tmpDir, config, 'note', 'Note A', 'Links to [[Note B]] here.\n');
    createNote(tmpDir, config, 'note', 'Note B', 'This is note B.\n');

    const dbPath = path.join(tmpDir, '.granite', 'index.db');
    const db = createDatabase(dbPath);
    rebuildIndex(tmpDir, config, db);

    // Check link exists
    const links = db.prepare('SELECT * FROM links WHERE source_slug = ?').all('note-a') as any[];
    expect(links).toHaveLength(1);
    expect(links[0].target_raw).toBe('Note B');
    expect(links[0].target_slug).toBe('note-b');

    db.close();
  });

  it('backlinks query returns correct results', () => {
    createNote(tmpDir, config, 'note', 'Source', 'See [[Target]] for details.\n');
    createNote(tmpDir, config, 'note', 'Target', 'I am the target.\n');

    const dbPath = path.join(tmpDir, '.granite', 'index.db');
    const db = createDatabase(dbPath);
    rebuildIndex(tmpDir, config, db);

    const backlinks = getBacklinks(db, 'target');
    expect(backlinks).toHaveLength(1);
    expect(backlinks[0].source_slug).toBe('source');
    expect(backlinks[0].source_title).toBe('Source');

    db.close();
  });

  it('handles broken links gracefully', () => {
    createNote(tmpDir, config, 'note', 'Broken', 'Links to [[Nonexistent]] page.\n');

    const dbPath = path.join(tmpDir, '.granite', 'index.db');
    const db = createDatabase(dbPath);
    rebuildIndex(tmpDir, config, db);

    const links = db.prepare('SELECT * FROM links WHERE source_slug = ?').all('broken') as any[];
    expect(links).toHaveLength(1);
    expect(links[0].target_slug).toBeNull();
    expect(links[0].target_raw).toBe('Nonexistent');

    db.close();
  });

  it('falls back to a transient rebuilt index when the persisted index is readonly', () => {
    createNote(tmpDir, config, 'note', 'Note A', 'Target.\n');

    const dbDir = path.join(tmpDir, '.granite');
    const dbPath = path.join(dbDir, 'index.db');
    const db = createDatabase(dbPath);
    rebuildIndex(tmpDir, config, db);
    db.close();

    createNote(tmpDir, config, 'note', 'Note B', 'Links to [[Note A]].\n');

    const readonlyPaths = [dbPath, `${dbPath}-shm`, `${dbPath}-wal`].filter(fs.existsSync);
    try {
      for (const file of readonlyPaths) fs.chmodSync(file, 0o444);
      fs.chmodSync(dbDir, 0o555);

      const rebuilt = ensureIndex(tmpDir, config);
      const count = rebuilt.prepare('SELECT COUNT(*) as c FROM notes').get() as { c: number };
      const backlinks = getBacklinks(rebuilt, 'note-a');

      expect(count.c).toBe(2);
      expect(backlinks.map(link => link.source_slug)).toContain('note-b');

      rebuilt.close();
    } finally {
      fs.chmodSync(dbDir, 0o755);
      for (const file of readonlyPaths) fs.chmodSync(file, 0o644);
    }
  });
});
