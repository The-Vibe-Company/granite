import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import { loadConfig } from '../../src/core/config.js';
import { createNote, findNoteBySlug } from '../../src/core/note.js';
import { createDatabase, rebuildIndex } from '../../src/core/index-db.js';
import type { GraniteConfig } from '../../src/core/types.js';

describe('typed hooks', () => {
  let tmpDir: string;
  let config: GraniteConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-hooks-'));
    const cfg: GraniteConfig = {
      vault_name: 'test',
      version: 1,
      note_types: {
        note: {
          folder: 'notes', description: 'notes', template: '', line_limit: 200, warn_only: false,
        },
        person: {
          folder: 'people',
          description: 'people',
          template: '## Context\n',
          line_limit: 200,
          warn_only: true,
          fields: {
            organization: { type: 'wikilink', target_types: ['organization'] },
          },
          on_create: [
            { action: 'resolve_wikilinks', fields: ['organization'], auto_stub: true },
          ],
          indexed_fields: ['organization'],
        },
        organization: {
          folder: 'orgs',
          description: 'orgs',
          template: '## Identity\n',
          line_limit: 300,
          warn_only: true,
          fields: {
            kind: { type: 'enum', options: ['client', 'partner'] },
          },
          indexed_fields: ['kind'],
        },
        meeting: {
          folder: 'meetings',
          description: 'meetings',
          template: '## Summary\n',
          line_limit: 300,
          warn_only: true,
          fields: {
            date: { type: 'date', required: true },
          },
          on_create: [
            { action: 'set_default', field: 'date', value: '${today}' },
          ],
          indexed_fields: ['date'],
        },
      },
      defaults: { note_type: 'note', editor: '$EDITOR' },
      index: { auto_rebuild: true },
    };
    fs.writeFileSync(path.join(tmpDir, 'granite.yml'), yaml.dump(cfg));
    for (const t of Object.values(cfg.note_types)) {
      fs.mkdirSync(path.join(tmpDir, t.folder), { recursive: true });
    }
    config = loadConfig(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolve_wikilinks auto_stub creates the target organization stub', () => {
    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    createNote(tmpDir, config, 'person', 'Alice Smith', '## Context\n', { author: 'stan',
      db,
      extraFrontmatter: { organization: 'Acme Corp' },
    });

    const alice = findNoteBySlug(tmpDir, config, 'alice-smith');
    expect(alice?.frontmatter.organization).toBe('acme-corp');

    const acme = findNoteBySlug(tmpDir, config, 'acme-corp');
    expect(acme).not.toBeNull();
    expect(acme?.frontmatter.type).toBe('organization');
    expect(acme?.frontmatter.tags).toContain('stub');

    db.close();
  });

  it('set_default fills in ${today} for missing fields', () => {
    createNote(tmpDir, config, 'meeting', 'Standup', '## Summary\n', { author: 'stan' });
    const note = findNoteBySlug(tmpDir, config, 'standup');
    const today = new Date().toISOString().slice(0, 10);
    expect(note?.frontmatter.date).toBe(today);
  });

  it('auto_stub allocates a unique slug when the target slug is taken by another type', () => {
    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    // A plain note whose slug would collide with the organization stub
    createNote(tmpDir, config, 'note', 'Acme', '## Acme is a word, not the company.\n', { author: 'stan' });
    rebuildIndex(tmpDir, config, db);

    createNote(tmpDir, config, 'person', 'Bob', '## Context\n', { author: 'stan',
      db,
      extraFrontmatter: { organization: 'Acme' },
    });

    const bob = findNoteBySlug(tmpDir, config, 'bob');
    // The stub should not overwrite the existing note: the field must point at a new slug.
    expect(bob?.frontmatter.organization).not.toBe('acme');
    expect(String(bob?.frontmatter.organization)).toMatch(/^acme-\d+$/);

    const acmeNote = findNoteBySlug(tmpDir, config, 'acme');
    expect(acmeNote?.frontmatter.type).toBe('note'); // Original note preserved.

    const acmeOrg = findNoteBySlug(tmpDir, config, String(bob?.frontmatter.organization));
    expect(acmeOrg?.frontmatter.type).toBe('organization');

    db.close();
  });

  it('resolve_wikilinks returns the existing slug when the target already exists', () => {
    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    createNote(tmpDir, config, 'organization', 'Acme', '## Identity\n', { author: 'stan',
      db,
      extraFrontmatter: { kind: 'client' },
    });
    rebuildIndex(tmpDir, config, db);

    createNote(tmpDir, config, 'person', 'Carol', '## Context\n', { author: 'stan',
      db,
      extraFrontmatter: { organization: 'Acme' },
    });

    const carol = findNoteBySlug(tmpDir, config, 'carol');
    expect(carol?.frontmatter.organization).toBe('acme');
    // No duplicate org stub should have been created.
    const acme = findNoteBySlug(tmpDir, config, 'acme');
    expect(acme?.frontmatter.tags ?? []).not.toContain('stub');

    db.close();
  });

  it('indexed_fields handles array values with blanks filtered out', () => {
    const cfgPath = path.join(tmpDir, 'granite.yml');
    const raw = yaml.load(fs.readFileSync(cfgPath, 'utf-8')) as GraniteConfig;
    raw.note_types.note = {
      ...raw.note_types.note,
      fields: { tags_list: { type: 'text' } },
      indexed_fields: ['tags_list'],
    };
    fs.writeFileSync(cfgPath, yaml.dump(raw));
    const config2 = loadConfig(tmpDir);

    createNote(tmpDir, config2, 'note', 'Arr', 'body\n', { author: 'stan',
      extraFrontmatter: { tags_list: ['a', '', 'b'] },
    });
    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    rebuildIndex(tmpDir, config2, db);
    const rows = db.prepare('SELECT field_value FROM note_fields WHERE slug = ? AND field_name = ?').all('arr', 'tags_list') as Array<{ field_value: string }>;
    const values = rows.map(r => r.field_value).sort();
    expect(values).toEqual(['a', 'b']);
    db.close();
  });

  it('auto_stub dedups repeated unresolved references in a single run', () => {
    const cfgPath = path.join(tmpDir, 'granite.yml');
    const raw = yaml.load(fs.readFileSync(cfgPath, 'utf-8')) as GraniteConfig;
    raw.note_types.person = {
      ...raw.note_types.person,
      fields: {
        organization: { type: 'wikilink', target_types: ['organization'] },
        backup_organization: { type: 'wikilink', target_types: ['organization'] },
      },
      on_create: [
        { action: 'resolve_wikilinks', fields: ['organization', 'backup_organization'], auto_stub: true },
      ],
      indexed_fields: ['organization', 'backup_organization'],
    };
    fs.writeFileSync(cfgPath, yaml.dump(raw));
    const cfg2 = loadConfig(tmpDir);

    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    createNote(tmpDir, cfg2, 'person', 'Dana', '## Context\n', { author: 'stan',
      db,
      extraFrontmatter: { organization: 'Acme Corp', backup_organization: 'Acme Corp' },
    });

    const dana = findNoteBySlug(tmpDir, cfg2, 'dana');
    expect(dana?.frontmatter.organization).toBe('acme-corp');
    expect(dana?.frontmatter.backup_organization).toBe('acme-corp');

    // Only one stub was created — no acme-corp-2.
    const dup = findNoteBySlug(tmpDir, cfg2, 'acme-corp-2');
    expect(dup).toBeNull();
    db.close();
  });

  it('createNote ignores attempts to overwrite reserved immutable fields via extraFrontmatter', () => {
    createNote(tmpDir, config, 'note', 'Guarded', 'body\n', { author: 'stan',
      extraFrontmatter: { id: 'forged', type: 'organization', created: 'never' },
    });
    const note = findNoteBySlug(tmpDir, config, 'guarded');
    expect(note?.frontmatter.type).toBe('note');
    expect(note?.frontmatter.id).not.toBe('forged');
    expect(note?.frontmatter.created).not.toBe('never');
  });

  it('indexed_fields are populated into note_fields table on rebuild', () => {
    createNote(tmpDir, config, 'organization', 'Acme', '## Identity\n', { author: 'stan',
      extraFrontmatter: { kind: 'client' },
    });
    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    rebuildIndex(tmpDir, config, db);
    const rows = db.prepare('SELECT field_name, field_value FROM note_fields WHERE slug = ?').all('acme');
    expect(rows).toContainEqual({ field_name: 'kind', field_value: 'client' });
    db.close();
  });
});
