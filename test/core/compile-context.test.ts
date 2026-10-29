import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import { loadConfig } from '../../src/core/config.js';
import { createNote } from '../../src/core/note.js';
import { createDatabase, rebuildIndex } from '../../src/core/index-db.js';
import { compileContext } from '../../src/core/compile-context.js';
import type { GraniteConfig } from '../../src/core/types.js';

describe('compileContext', () => {
  let tmpDir: string;
  let config: GraniteConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-compile-'));
    const cfg: GraniteConfig = {
      vault_name: 't', version: 1,
      note_types: {
        note: { folder: 'notes', description: '', template: '', line_limit: 200, warn_only: false },
        person: {
          folder: 'people',
          description: '',
          template: '## Context\n',
          line_limit: 200,
          warn_only: true,
          fields: { organization: { type: 'wikilink', target_types: ['organization'] } },
          indexed_fields: ['organization'],
        },
        organization: {
          folder: 'orgs',
          description: '',
          template: '',
          line_limit: 300,
          warn_only: true,
          fields: { kind: { type: 'enum', options: ['client'] } },
          indexed_fields: ['kind'],
        },
        meeting: {
          folder: 'meetings',
          description: '',
          template: '## Summary\n',
          line_limit: 300,
          warn_only: true,
          fields: {
            date: { type: 'date' },
            organization: { type: 'wikilink', target_types: ['organization'] },
          },
          indexed_fields: ['date', 'organization'],
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

  it('compiles organization context with Team and Recent meetings sections', () => {
    createNote(tmpDir, config, 'organization', 'Acme', '## Identity\n', {
      extraFrontmatter: { kind: 'client' },
    });
    createNote(tmpDir, config, 'person', 'Alice', '## Context\nWorks at [[acme]].\n', {
      extraFrontmatter: { organization: 'acme' },
    });
    createNote(tmpDir, config, 'meeting', 'Kickoff 2026', '## Summary\n[[acme]] kickoff.\n', {
      extraFrontmatter: { date: '2026-03-01', organization: 'acme' },
    });

    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    rebuildIndex(tmpDir, config, db);

    const ctx = compileContext(db, config, { slug: 'acme' });
    expect(ctx.mode).toBe('slug');
    expect(ctx.title).toBe('Acme');
    const headings = ctx.sections.map(s => s.heading);
    expect(headings).toContain('Team');
    expect(headings).toContain('Recent meetings');
    const team = ctx.sections.find(s => s.heading === 'Team')!;
    expect(team.entries.map(e => e.slug)).toContain('alice');
    db.close();
  });

  it('compiles a topic by searching and grouping by type', () => {
    createNote(tmpDir, config, 'note', 'Distillation notes', 'Notes on distillation.\n');
    createNote(tmpDir, config, 'organization', 'Distillery Co', 'A distillation company.\n');

    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    rebuildIndex(tmpDir, config, db);

    const ctx = compileContext(db, config, { topic: 'distillation' });
    expect(ctx.mode).toBe('topic');
    expect(ctx.title).toBe('distillation');
    expect(ctx.sections.length).toBeGreaterThan(0);
    db.close();
  });

  it('throws when neither topic nor slug is provided', () => {
    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    rebuildIndex(tmpDir, config, db);
    expect(() => compileContext(db, config, {})).toThrow(/topic or slug/);
    db.close();
  });

  it('throws when slug does not exist', () => {
    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    rebuildIndex(tmpDir, config, db);
    expect(() => compileContext(db, config, { slug: 'unknown' })).toThrow(/not found/);
    db.close();
  });

  it('includes backlinks section when present', () => {
    createNote(tmpDir, config, 'note', 'Target', 'Target note.\n');
    createNote(tmpDir, config, 'note', 'Source', 'See [[target]].\n');

    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    rebuildIndex(tmpDir, config, db);

    const ctx = compileContext(db, config, { slug: 'target' });
    const backlinks = ctx.sections.find(s => s.heading === 'Backlinks');
    expect(backlinks).toBeDefined();
    expect(backlinks!.entries.map(e => e.slug)).toContain('source');
    db.close();
  });

  it('deduplicates repeated mentions before applying the backlink limit', () => {
    createNote(tmpDir, config, 'note', 'Target', 'Target note.\n');
    createNote(
      tmpDir,
      config,
      'note',
      'Source',
      'First context for [[target]].\nSecond context for [[target]].\n',
    );
    createNote(tmpDir, config, 'note', 'Z Other source', 'Another note linking [[target]].\n');

    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    rebuildIndex(tmpDir, config, db);

    const ctx = compileContext(db, config, { slug: 'target', limit: 2 });
    const backlinks = ctx.sections.find(s => s.heading === 'Backlinks')!;
    expect(backlinks.entries).toHaveLength(2);
    expect(backlinks.entries.map(entry => entry.slug)).toEqual(['source', 'z-other-source']);
    const source = backlinks.entries.find(entry => entry.slug === 'source')!;
    expect(source.reason).toContain('First context');
    db.close();
  });
});
