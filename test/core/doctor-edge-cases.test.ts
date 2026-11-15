import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, writeDefaultConfig } from '../../src/core/config.js';
import { createDatabase, rebuildIndex } from '../../src/core/index-db.js';
import { createNote } from '../../src/core/note.js';
import { parseFrontmatter, serializeFrontmatter } from '../../src/core/frontmatter.js';
import { runDoctor } from '../../src/core/doctor.js';
import type { GraniteConfig } from '../../src/core/types.js';

describe('doctor edge cases', () => {
  let tmpDir: string;
  let config: GraniteConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-doctor-edges-'));
    writeDefaultConfig(tmpDir);
    config = loadConfig(tmpDir);
    for (const typeConfig of Object.values(config.note_types)) {
      fs.mkdirSync(path.join(tmpDir, typeConfig.folder), { recursive: true });
    }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function getDb(rebuild = true) {
    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    if (rebuild) {
      rebuildIndex(tmpDir, config, db);
    }
    return db;
  }

  it('reports missing note-type folders', () => {
    fs.rmSync(path.join(tmpDir, config.note_types.source.folder), { recursive: true, force: true });

    const db = getDb(false);
    const issues = runDoctor(tmpDir, config, db);
    db.close();

    expect(issues.some(issue => issue.message.includes('folder does not exist'))).toBe(true);
  });

  it('reports missing frontmatter fields, duplicate slugs, and duplicate ids', () => {
    const first = createNote(tmpDir, config, 'note', 'Shared Title', 'Body.\n', { author: 'stan' });
    const second = createNote(tmpDir, config, 'source', 'Another Title', 'Body.\n', { author: 'stan' });

    const firstContent = fs.readFileSync(first.filepath, 'utf-8');
    const { frontmatter } = parseFrontmatter(firstContent);

    const duplicateSlugPath = path.join(tmpDir, config.note_types.source.folder, `${first.slug}.md`);
    fs.writeFileSync(duplicateSlugPath, serializeFrontmatter(frontmatter, 'Duplicate slug.\n'), 'utf-8');

    const secondContent = fs.readFileSync(second.filepath, 'utf-8');
    const parsedSecond = parseFrontmatter(secondContent);
    parsedSecond.frontmatter.id = frontmatter.id;
    delete parsedSecond.frontmatter.title;
    delete parsedSecond.frontmatter.type;
    delete parsedSecond.frontmatter.created;
    fs.writeFileSync(second.filepath, serializeFrontmatter(parsedSecond.frontmatter, parsedSecond.body), 'utf-8');

    const db = getDb(false);
    const issues = runDoctor(tmpDir, config, db);
    db.close();

    expect(issues.some(issue => issue.message.includes('Missing frontmatter field: title'))).toBe(true);
    expect(issues.some(issue => issue.message.includes('Missing frontmatter field: type'))).toBe(true);
    expect(issues.some(issue => issue.message.includes('Missing frontmatter field: created'))).toBe(true);
    expect(issues.some(issue => issue.message.includes('Duplicate slug'))).toBe(true);
    expect(issues.some(issue => issue.message.includes('Duplicate note ID'))).toBe(true);
  });
});
