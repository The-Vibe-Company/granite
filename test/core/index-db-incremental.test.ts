import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, writeDefaultConfig } from '../../src/core/config.js';
import { createDatabase, openDatabase, rebuildIndex, syncNoteInIndex, syncVaultIndexAfterNoteWrite } from '../../src/core/index-db.js';
import { createNote, findNoteBySlug, readNote } from '../../src/core/note.js';
import { parseFrontmatter, serializeFrontmatter } from '../../src/core/frontmatter.js';
import type { GraniteConfig } from '../../src/core/types.js';

describe('index-db incremental flows', () => {
  let tmpDir: string;
  let config: GraniteConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-idx-incremental-'));
    writeDefaultConfig(tmpDir);
    config = loadConfig(tmpDir);
    for (const typeConfig of Object.values(config.note_types)) {
      fs.mkdirSync(path.join(tmpDir, typeConfig.folder), { recursive: true });
    }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('recreates the index when the schema version is outdated', () => {
    const dbPath = path.join(tmpDir, '.granite', 'index.db');
    const firstDb = createDatabase(dbPath);
    firstDb.prepare('UPDATE meta SET value = ? WHERE key = ?').run('1', 'schema_version');
    firstDb.close();

    const reopened = openDatabase(tmpDir);
    const version = reopened.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value: string };
    expect(version.value).toBe('3');
    reopened.close();
  });

  it('syncs a single note incrementally and resolves alias links', () => {
    createNote(tmpDir, config, 'note', 'Target Note', 'Target.\n');

    const targetPath = path.join(tmpDir, config.note_types.note.folder, 'target-note.md');
    const targetContent = fs.readFileSync(targetPath, 'utf-8');
    fs.writeFileSync(
      targetPath,
      targetContent.replace('aliases: []', 'aliases:\n  - TN'),
      'utf-8',
    );

    const draft = createNote(tmpDir, config, 'note', 'Draft', 'Start.\n');

    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    rebuildIndex(tmpDir, config, db);

    const draftNote = findNoteBySlug(tmpDir, config, draft.slug);
    expect(draftNote).not.toBeNull();

    const updatedDraft = {
      ...draftNote!,
      body: 'Updated body with [[TN]].\n',
    };

    syncNoteInIndex(tmpDir, config, db, updatedDraft);

    const stored = db.prepare('SELECT body FROM notes WHERE slug = ?').get('draft') as { body: string };
    const link = db.prepare('SELECT target_slug FROM links WHERE source_slug = ?').get('draft') as { target_slug: string };

    expect(stored.body).toContain('[[TN]]');
    expect(link.target_slug).toBe('target-note');

    db.close();
  });

  it('rebuilds the whole index when note counts drift from disk', () => {
    const keep = createNote(tmpDir, config, 'note', 'Keep', 'Still here.\n');
    const remove = createNote(tmpDir, config, 'note', 'Remove', 'Will be deleted.\n');

    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    rebuildIndex(tmpDir, config, db);

    fs.unlinkSync(remove.filepath);

    syncNoteInIndex(tmpDir, config, db, readNote(keep.filepath));

    const count = db.prepare('SELECT COUNT(*) as c FROM notes').get() as { c: number };
    expect(count.c).toBe(1);
    expect(
      db.prepare('SELECT slug FROM notes').all() as Array<{ slug: string }>,
    ).toEqual([{ slug: 'keep' }]);

    db.close();
  });

  it('rebuilds backlinks when a newly created note resolves older broken links', () => {
    createNote(tmpDir, config, 'note', 'Existing Source', 'Points to [[Future Note]].\n');

    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    rebuildIndex(tmpDir, config, db);

    const unresolved = db.prepare('SELECT target_slug FROM links WHERE source_slug = ?').get('existing-source') as { target_slug: string | null };
    expect(unresolved.target_slug).toBeNull();
    db.close();

    const future = createNote(tmpDir, config, 'note', 'Future Note', 'Arrived later.\n');
    syncVaultIndexAfterNoteWrite(tmpDir, config, future);

    const reopened = openDatabase(tmpDir);
    const resolved = reopened.prepare('SELECT target_slug FROM links WHERE source_slug = ?').get('existing-source') as { target_slug: string | null };
    expect(resolved.target_slug).toBe('future-note');
    reopened.close();
  });

  it('keeps malformed alias JSON from crashing link resolution', () => {
    createNote(tmpDir, config, 'note', 'Target Note', 'Target.\n');

    const targetPath = path.join(tmpDir, config.note_types.note.folder, 'target-note.md');
    const targetContent = fs.readFileSync(targetPath, 'utf-8');
    const parsed = parseFrontmatter(targetContent);
    parsed.frontmatter.aliases = [] as string[];
    fs.writeFileSync(
      targetPath,
      serializeFrontmatter(parsed.frontmatter, parsed.body),
      'utf-8',
    );

    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    rebuildIndex(tmpDir, config, db);
    db.prepare('UPDATE notes SET aliases = ? WHERE slug = ?').run('not-json', 'target-note');

    const note = createNote(tmpDir, config, 'note', 'Draft', 'Link to [[Target Note]].\n');
    syncNoteInIndex(tmpDir, config, db, readNote(note.filepath));

    const link = db.prepare('SELECT target_slug FROM links WHERE source_slug = ?').get('draft') as { target_slug: string };
    expect(link.target_slug).toBe('target-note');

    db.close();
  });

  it('does not fail a completed note write when the persistent index is readonly', () => {
    const dbDir = path.join(tmpDir, '.granite');
    const dbPath = path.join(dbDir, 'index.db');
    const db = createDatabase(dbPath);
    rebuildIndex(tmpDir, config, db);
    db.close();

    const note = createNote(tmpDir, config, 'note', 'Readonly Index Note', 'Durable markdown write.\n');
    const readonlyPaths = [dbPath, `${dbPath}-shm`, `${dbPath}-wal`].filter(fs.existsSync);

    try {
      for (const file of readonlyPaths) fs.chmodSync(file, 0o444);
      fs.chmodSync(dbDir, 0o555);

      expect(() => syncVaultIndexAfterNoteWrite(tmpDir, config, note)).not.toThrow();
      expect(fs.existsSync(note.filepath)).toBe(true);
    } finally {
      fs.chmodSync(dbDir, 0o755);
      for (const file of readonlyPaths) fs.chmodSync(file, 0o644);
    }
  });
});
