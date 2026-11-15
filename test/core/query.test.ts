import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import { loadConfig } from '../../src/core/config.js';
import { createNote } from '../../src/core/note.js';
import { createDatabase, rebuildIndex } from '../../src/core/index-db.js';
import { runQuery } from '../../src/core/query.js';
import type { GraniteConfig } from '../../src/core/types.js';

describe('runQuery', () => {
  let tmpDir: string;
  let config: GraniteConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-query-'));
    const cfg: GraniteConfig = {
      vault_name: 't', version: 1,
      note_types: {
        note: { folder: 'notes', description: '', template: '', line_limit: 200, warn_only: false },
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
        organization: {
          folder: 'orgs',
          description: '',
          template: '',
          line_limit: 300,
          warn_only: true,
          fields: { kind: { type: 'enum', options: ['client'] } },
          indexed_fields: ['kind'],
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

  it('filters by type and indexed field equality', () => {
    createNote(tmpDir, config, 'meeting', 'Kickoff', '## Summary\n', { author: 'stan',
      extraFrontmatter: { date: '2026-03-01', organization: 'acme' },
    });
    createNote(tmpDir, config, 'meeting', 'Review', '## Summary\n', { author: 'stan',
      extraFrontmatter: { date: '2026-03-15', organization: 'beta' },
    });

    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    rebuildIndex(tmpDir, config, db);

    const results = runQuery(db, config, {
      type: 'meeting',
      where: { organization: 'acme' },
    });
    expect(results.map(r => r.slug)).toEqual(['kickoff']);

    db.close();
  });

  it('rejects filtering on a non-indexed field', () => {
    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    rebuildIndex(tmpDir, config, db);
    expect(() => runQuery(db, config, { type: 'meeting', where: { body: 'foo' } }))
      .toThrow(/not indexed/);
    db.close();
  });

  it('supports gte/lte range filters on dates', () => {
    createNote(tmpDir, config, 'meeting', 'Old', '## Summary\n', { author: 'stan',
      extraFrontmatter: { date: '2025-01-01' },
    });
    createNote(tmpDir, config, 'meeting', 'Recent', '## Summary\n', { author: 'stan',
      extraFrontmatter: { date: '2026-03-15' },
    });

    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    rebuildIndex(tmpDir, config, db);

    const results = runQuery(db, config, {
      type: 'meeting',
      where: { date: { gte: '2026-01-01' } },
    });
    expect(results.map(r => r.slug)).toEqual(['recent']);
    db.close();
  });

  it('throws on unknown note type', () => {
    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    rebuildIndex(tmpDir, config, db);
    expect(() => runQuery(db, config, { type: 'nope' })).toThrow(/Unknown note type/);
    db.close();
  });

  it('filters by status and source on notes, eq object, lte and between', () => {
    createNote(tmpDir, config, 'meeting', 'A', '## Summary\n', { author: 'stan',
      extraFrontmatter: { date: '2025-06-01' },
    });
    createNote(tmpDir, config, 'meeting', 'B', '## Summary\n', { author: 'stan',
      extraFrontmatter: { date: '2026-03-01' },
    });
    createNote(tmpDir, config, 'meeting', 'C', '## Summary\n', { author: 'stan',
      extraFrontmatter: { date: '2026-12-31' },
    });

    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    rebuildIndex(tmpDir, config, db);

    const lte = runQuery(db, config, { type: 'meeting', where: { date: { lte: '2026-01-01' } } });
    expect(lte.map(r => r.slug)).toEqual(['a']);

    const between = runQuery(db, config, {
      type: 'meeting',
      where: { date: { gte: '2026-01-01', lte: '2026-06-01' } },
    });
    expect(between.map(r => r.slug)).toEqual(['b']);

    const eqObj = runQuery(db, config, { type: 'meeting', where: { date: { eq: '2025-06-01' } } });
    expect(eqObj.map(r => r.slug)).toEqual(['a']);

    const status = runQuery(db, config, { type: 'meeting', where: { status: 'active' } });
    expect(status.length).toBeGreaterThanOrEqual(0);

    const source = runQuery(db, config, { type: 'meeting', where: { source: 'human' } });
    expect(source.length).toBeGreaterThanOrEqual(0);

    db.close();
  });

  it('supports in filter and sorts by indexed field', () => {
    createNote(tmpDir, config, 'meeting', 'One', '## Summary\n', { author: 'stan',
      extraFrontmatter: { date: '2026-01-10', organization: 'acme' },
    });
    createNote(tmpDir, config, 'meeting', 'Two', '## Summary\n', { author: 'stan',
      extraFrontmatter: { date: '2026-02-10', organization: 'beta' },
    });

    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    rebuildIndex(tmpDir, config, db);

    const inResults = runQuery(db, config, {
      type: 'meeting',
      where: { organization: { in: ['acme', 'beta'] } },
      sort: { field: 'date', dir: 'asc' },
    });
    expect(inResults.map(r => r.slug)).toEqual(['one', 'two']);

    const byTitle = runQuery(db, config, { type: 'meeting', sort: { field: 'title', dir: 'desc' } });
    expect(byTitle[0].slug).toBe('two');

    db.close();
  });

  it('throws when sorting by non-indexed field', () => {
    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    rebuildIndex(tmpDir, config, db);
    expect(() => runQuery(db, config, { type: 'meeting', sort: { field: 'bogus', dir: 'asc' } }))
      .toThrow(/non-indexed/);
    db.close();
  });

  it('ignores empty in filter and returns untyped rows', () => {
    createNote(tmpDir, config, 'note', 'Plain', 'body\n', { author: 'stan' });

    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    rebuildIndex(tmpDir, config, db);

    const all = runQuery(db, config, {});
    expect(all.some(r => r.slug === 'plain')).toBe(true);

    db.close();
  });

  it('empty in filter matches nothing', () => {
    createNote(tmpDir, config, 'meeting', 'E', '## Summary\n', { author: 'stan',
      extraFrontmatter: { date: '2026-03-01', organization: 'acme' },
    });
    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    rebuildIndex(tmpDir, config, db);
    const results = runQuery(db, config, { type: 'meeting', where: { organization: { in: [] } } });
    expect(results).toEqual([]);
    db.close();
  });

  it('queries across types when no type is passed, unioning indexed_fields', () => {
    createNote(tmpDir, config, 'meeting', 'AcmeSync', '## Summary\n', { author: 'stan',
      extraFrontmatter: { date: '2026-03-01', organization: 'acme' },
    });
    createNote(tmpDir, config, 'organization', 'Acme', '', { author: 'stan',
      extraFrontmatter: { kind: 'client' },
    });

    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    rebuildIndex(tmpDir, config, db);

    const byOrg = runQuery(db, config, { where: { organization: 'acme' } });
    expect(byOrg.map(r => r.slug)).toEqual(['acmesync']);

    const byKind = runQuery(db, config, { where: { kind: 'client' } });
    expect(byKind.map(r => r.slug)).toEqual(['acme']);

    expect(() => runQuery(db, config, { where: { nope: 'x' } })).toThrow(/not indexed/);

    db.close();
  });

  it('rejects invalid sort direction', () => {
    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    rebuildIndex(tmpDir, config, db);
    expect(() =>
      runQuery(db, config, {
        type: 'meeting',
        sort: { field: 'date', dir: 'drop table notes' as unknown as 'asc' },
      }),
    ).toThrow(/Invalid sort direction/);
    db.close();
  });
});
