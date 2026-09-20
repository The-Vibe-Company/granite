import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { GraniteConfig, Note } from './types.js';
import { listNotes } from './note.js';
import { parseWikilinks } from './wikilinks.js';
import { slugify } from './slugify.js';
import { collectIndexedFieldValues } from './hooks.js';
import { getIndexDbPath } from './vault.js';

const SCHEMA_VERSION = 3;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS notes (
  slug        TEXT PRIMARY KEY,
  id          TEXT UNIQUE NOT NULL,
  title       TEXT NOT NULL,
  type        TEXT NOT NULL,
  created     TEXT NOT NULL,
  modified    TEXT NOT NULL,
  tags        TEXT,
  aliases     TEXT,
  body        TEXT NOT NULL,
  filepath    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',
  source      TEXT NOT NULL DEFAULT 'human'
);

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  title,
  body,
  tags,
  content='notes',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, title, body, tags)
    VALUES (new.rowid, new.title, new.body, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, body, tags)
    VALUES ('delete', old.rowid, old.title, old.body, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, body, tags)
    VALUES ('delete', old.rowid, old.title, old.body, old.tags);
  INSERT INTO notes_fts(rowid, title, body, tags)
    VALUES (new.rowid, new.title, new.body, new.tags);
END;

CREATE TABLE IF NOT EXISTS links (
  source_slug   TEXT NOT NULL,
  target_slug   TEXT,
  target_raw    TEXT NOT NULL,
  context       TEXT,
  FOREIGN KEY (source_slug) REFERENCES notes(slug)
);

CREATE INDEX IF NOT EXISTS idx_links_target ON links(target_slug);
CREATE INDEX IF NOT EXISTS idx_links_source ON links(source_slug);

CREATE TABLE IF NOT EXISTS note_fields (
  slug        TEXT NOT NULL,
  field_name  TEXT NOT NULL,
  field_value TEXT NOT NULL,
  FOREIGN KEY (slug) REFERENCES notes(slug)
);

CREATE INDEX IF NOT EXISTS idx_note_fields_slug ON note_fields(slug);
CREATE INDEX IF NOT EXISTS idx_note_fields_name_value ON note_fields(field_name, field_value);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

export function createDatabase(dbPath: string): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA_SQL);
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
  return db;
}

function createTransientDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA_SQL);
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
  return db;
}

export function openDatabase(vaultRoot: string): Database.Database {
  const dbPath = getIndexDbPath(vaultRoot);
  if (!fs.existsSync(dbPath)) {
    return createDatabase(dbPath);
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  // Check schema version — if outdated, drop and recreate
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value: string } | undefined;
  const currentVersion = row ? Number(row.value) : 0;
  if (currentVersion < SCHEMA_VERSION) {
    db.close();
    fs.unlinkSync(dbPath);
    return createDatabase(dbPath);
  }

  return db;
}

export function rebuildIndex(vaultRoot: string, config: GraniteConfig, db: Database.Database): void {
  const notes = listNotes(vaultRoot, config);

  const insertNote = db.prepare(`
    INSERT INTO notes (slug, id, title, type, created, modified, tags, aliases, body, filepath, status, source)
    VALUES (@slug, @id, @title, @type, @created, @modified, @tags, @aliases, @body, @filepath, @status, @source)
  `);

  const insertLink = db.prepare(`
    INSERT INTO links (source_slug, target_slug, target_raw, context)
    VALUES (@source_slug, @target_slug, @target_raw, @context)
  `);

  const insertField = db.prepare(`
    INSERT INTO note_fields (slug, field_name, field_value)
    VALUES (@slug, @field_name, @field_value)
  `);

  const transaction = db.transaction(() => {
    db.exec('DELETE FROM links');
    db.exec('DELETE FROM note_fields');
    db.exec('DELETE FROM notes');
    // Rebuild FTS after clearing the content table, but keep this inside
    // the transaction so concurrent readers/writers never observe a half-reset index.
    db.exec("INSERT INTO notes_fts(notes_fts) VALUES('rebuild')");

    for (const note of notes) {
      insertNote.run({
        slug: note.slug,
        id: note.frontmatter.id,
        title: note.frontmatter.title,
        type: note.frontmatter.type,
        created: note.frontmatter.created,
        modified: note.frontmatter.modified,
        tags: JSON.stringify(note.frontmatter.tags),
        aliases: JSON.stringify(note.frontmatter.aliases),
        body: note.body,
        filepath: note.filepath,
        status: note.frontmatter.status ?? 'active',
        source: note.frontmatter.source ?? 'human',
      });

      // Parse and resolve wikilinks
      const links = parseWikilinks(note.body);
      const resolved = resolveLinksAgainstNotes(links, notes);

      for (const link of resolved) {
        // Find context line
        const bodyLines = note.body.split('\n');
        const contextLine = bodyLines.find(l => l.includes(link.raw)) ?? '';

        insertLink.run({
          source_slug: note.slug,
          target_slug: link.resolved_slug ?? null,
          target_raw: link.target,
          context: contextLine.trim(),
        });
      }

      const typeConfig = config.note_types[note.frontmatter.type];
      if (typeConfig) {
        for (const entry of collectIndexedFieldValues(note, typeConfig)) {
          insertField.run({
            slug: note.slug,
            field_name: entry.field,
            field_value: entry.value,
          });
        }
      }
    }

    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('last_rebuild', new Date().toISOString());
  });

  transaction();
}

export function syncNoteInIndex(
  vaultRoot: string,
  config: GraniteConfig,
  db: Database.Database,
  note: Note,
): void {
  const noteCountInDb = db.prepare('SELECT COUNT(*) as c FROM notes').get() as { c: number };
  const noteCountOnDisk = countNoteFiles(vaultRoot, config);
  const noteExists = db.prepare('SELECT 1 FROM notes WHERE slug = ?').get(note.slug) as { 1: number } | undefined;
  const allowedCount = noteExists ? noteCountOnDisk : noteCountOnDisk - 1;

  if (noteCountInDb.c !== allowedCount) {
    rebuildIndex(vaultRoot, config, db);
    return;
  }

  upsertNoteAndLinks(db, note, config);
}

export function syncVaultIndexAfterNoteWrite(
  vaultRoot: string,
  config: GraniteConfig,
  note: Note,
  options: { rebuild?: boolean } = {},
): void {
  let db: Database.Database | undefined;

  try {
    db = openDatabase(vaultRoot);
    const noteExists = db.prepare('SELECT 1 FROM notes WHERE slug = ?').get(note.slug) as { 1: number } | undefined;

    if (options.rebuild || !noteExists) {
      rebuildIndex(vaultRoot, config, db);
      return;
    }

    syncNoteInIndex(vaultRoot, config, db, note);
  } catch (error) {
    if (isSqliteReadonlyError(error)) {
      // The markdown note write already happened. In sandboxed automation runs the
      // persistent SQLite index may be read-only, so leave it to the next read to
      // build a transient index instead of failing the user-visible write command.
      return;
    }
    throw error;
  } finally {
    db?.close();
  }
}

export function ensureIndex(vaultRoot: string, config: GraniteConfig): Database.Database {
  let db: Database.Database | undefined;

  try {
    db = openDatabase(vaultRoot);

    if (config.index.auto_rebuild) {
      rebuildIndex(vaultRoot, config, db);
    }

    return db;
  } catch (error) {
    db?.close();
    if (!isSqliteReadonlyError(error)) {
      throw error;
    }

    const transientDb = createTransientDatabase();
    try {
      rebuildIndex(vaultRoot, config, transientDb);
      return transientDb;
    } catch (transientError) {
      transientDb.close();
      throw transientError;
    }
  }
}

function countNoteFiles(vaultRoot: string, config: GraniteConfig): number {
  let count = 0;

  for (const typeConfig of Object.values(config.note_types)) {
    const folder = path.join(vaultRoot, typeConfig.folder);
    if (!fs.existsSync(folder)) continue;
    count += fs.readdirSync(folder).filter(file => file.endsWith('.md')).length;
  }

  return count;
}

function upsertNoteAndLinks(db: Database.Database, note: Note, config?: GraniteConfig): void {
  const upsertNote = db.prepare(`
    INSERT INTO notes (slug, id, title, type, created, modified, tags, aliases, body, filepath, status, source)
    VALUES (@slug, @id, @title, @type, @created, @modified, @tags, @aliases, @body, @filepath, @status, @source)
    ON CONFLICT(slug) DO UPDATE SET
      id = excluded.id,
      title = excluded.title,
      type = excluded.type,
      created = excluded.created,
      modified = excluded.modified,
      tags = excluded.tags,
      aliases = excluded.aliases,
      body = excluded.body,
      filepath = excluded.filepath,
      status = excluded.status,
      source = excluded.source
  `);

  const deleteLinks = db.prepare('DELETE FROM links WHERE source_slug = ?');
  const deleteFields = db.prepare('DELETE FROM note_fields WHERE slug = ?');
  const insertLink = db.prepare(`
    INSERT INTO links (source_slug, target_slug, target_raw, context)
    VALUES (@source_slug, @target_slug, @target_raw, @context)
  `);
  const insertField = db.prepare(`
    INSERT INTO note_fields (slug, field_name, field_value)
    VALUES (@slug, @field_name, @field_value)
  `);

  const transaction = db.transaction(() => {
    upsertNote.run({
      slug: note.slug,
      id: note.frontmatter.id,
      title: note.frontmatter.title,
      type: note.frontmatter.type,
      created: note.frontmatter.created,
      modified: note.frontmatter.modified,
      tags: JSON.stringify(note.frontmatter.tags),
      aliases: JSON.stringify(note.frontmatter.aliases),
      body: note.body,
      filepath: note.filepath,
      status: note.frontmatter.status ?? 'active',
      source: note.frontmatter.source ?? 'human',
    });

    deleteLinks.run(note.slug);
    deleteFields.run(note.slug);

    const links = parseWikilinks(note.body);
    for (const link of links) {
      const resolvedSlug = resolveLinkTarget(db, link.target);
      const contextLine = note.body.split('\n').find(line => line.includes(link.raw)) ?? '';

      insertLink.run({
        source_slug: note.slug,
        target_slug: resolvedSlug,
        target_raw: link.target,
        context: contextLine.trim(),
      });
    }

    if (config) {
      const typeConfig = config.note_types[note.frontmatter.type];
      if (typeConfig) {
        for (const entry of collectIndexedFieldValues(note, typeConfig)) {
          insertField.run({
            slug: note.slug,
            field_name: entry.field,
            field_value: entry.value,
          });
        }
      }
    }

    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('last_rebuild', new Date().toISOString());
  });

  transaction();
}

function resolveLinksAgainstNotes(links: ReturnType<typeof parseWikilinks>, allNotes: Note[]) {
  return links.map(link => {
    const targetSlug = slugify(link.target);

    let found = allNotes.find(note => note.slug === targetSlug);
    if (!found) {
      found = allNotes.find(note => note.frontmatter.title.toLowerCase() === link.target.toLowerCase());
    }
    if (!found) {
      found = allNotes.find(note =>
        note.frontmatter.aliases.some(alias => alias.toLowerCase() === link.target.toLowerCase()),
      );
    }

    return {
      ...link,
      resolved: !!found,
      resolved_slug: found?.slug,
    };
  });
}

function resolveLinkTarget(db: Database.Database, target: string): string | null {
  const targetSlug = slugify(target);
  const exact = db.prepare(`
    SELECT slug
    FROM notes
    WHERE slug = ? OR lower(title) = ?
    LIMIT 1
  `).get(targetSlug, target.toLowerCase()) as { slug: string } | undefined;

  if (exact) return exact.slug;

  const rows = db.prepare('SELECT slug, aliases FROM notes').all() as Array<{ slug: string; aliases: string }>;
  for (const row of rows) {
    try {
      const aliases = JSON.parse(row.aliases || '[]') as unknown[];
      if (aliases.some(alias => typeof alias === 'string' && alias.toLowerCase() === target.toLowerCase())) {
        return row.slug;
      }
    } catch {
      continue;
    }
  }

  return null;
}

function isSqliteReadonlyError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = 'code' in error ? String((error as { code?: unknown }).code) : '';
  const message = 'message' in error ? String((error as { message?: unknown }).message) : '';
  return code === 'SQLITE_READONLY' || message.includes('readonly database');
}
