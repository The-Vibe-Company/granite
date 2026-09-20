import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import { loadConfig } from '../../src/core/config.js';
import { createNote, findNoteBySlug } from '../../src/core/note.js';
import { createDatabase, rebuildIndex } from '../../src/core/index-db.js';
import { suggestLinks } from '../../src/core/suggest.js';
import type { GraniteConfig } from '../../src/core/types.js';

describe('suggestLinks', () => {
  let tmpDir: string;
  let config: GraniteConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-suggest-'));
    const cfg: GraniteConfig = {
      vault_name: 't',
      version: 1,
      note_types: {
        note: { folder: 'notes', description: '', template: '', line_limit: 200, warn_only: false },
      },
      defaults: { note_type: 'note', editor: '$EDITOR' },
      index: { auto_rebuild: true },
    };
    fs.writeFileSync(path.join(tmpDir, 'granite.yml'), yaml.dump(cfg));
    fs.mkdirSync(path.join(tmpDir, 'notes'), { recursive: true });
    config = loadConfig(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Rebuild the index and return a reader bound to the current graph. */
  function withDb<T>(fn: (run: (slug: string, limit?: number) => ReturnType<typeof suggestLinks>) => T): T {
    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    rebuildIndex(tmpDir, config, db);
    try {
      return fn((slug, limit) => {
        const source = findNoteBySlug(tmpDir, config, slug);
        if (!source) throw new Error(`source note missing: ${slug}`);
        return suggestLinks(db, source, limit);
      });
    } finally {
      db.close();
    }
  }

  it('matches a whole-word mention of another note title', () => {
    createNote(tmpDir, config, 'note', 'CursorMoK', 'unrelated.\n');
    createNote(tmpDir, config, 'note', 'Source Note', 'We compared CursorMoK against the baseline.\n');
    const result = withDb(run => run('source-note'));
    expect(result.map(s => s.target_slug)).toContain('cursormok');
  });

  it('does not match a title or alias inside a larger word', () => {
    createNote(tmpDir, config, 'note', 'Mixture of Kittens', 'body text.\n', { extraFrontmatter: { aliases: ['MoK'] } });
    createNote(tmpDir, config, 'note', 'Source Note', 'Nous avons prepare un mokeup de la page.\n');
    const result = withDb(run => run('source-note'));
    expect(result).toEqual([]);
  });

  it('still matches the same alias when it stands alone', () => {
    createNote(tmpDir, config, 'note', 'Mixture of Kittens', 'body text.\n', { extraFrontmatter: { aliases: ['MoK'] } });
    createNote(tmpDir, config, 'note', 'Source Note', 'We benchmarked MoK on the cluster.\n');
    const result = withDb(run => run('source-note'));
    expect(result.map(s => s.target_slug)).toEqual(['mixture-of-kittens']);
    expect(result[0].mentions).toBe(1);
  });

  it('ignores a match that already sits inside a wikilink', () => {
    createNote(tmpDir, config, 'note', 'Monka Recap', 'body text.\n', { extraFrontmatter: { aliases: ['TVC'] } });
    createNote(tmpDir, config, 'note', 'Source Note', 'See [[TVC]] for the recap.\n');
    // "TVC" is the only spelling present and it is already linked, so nothing
    // should be suggested — this is the alias-not-filtered bug.
    const result = withDb(run => run('source-note'));
    expect(result).toEqual([]);
  });

  it('still suggests a note whose alias appears as unlinked prose', () => {
    createNote(tmpDir, config, 'note', 'Monka Recap', 'body text.\n', { extraFrontmatter: { aliases: ['TVC'] } });
    createNote(tmpDir, config, 'note', 'Some Note', 'body text.\n');
    createNote(tmpDir, config, 'note', 'Source Note', 'We discussed TVC context at length.\n');
    const result = withDb(run => run('source-note'));
    expect(result.map(s => s.target_slug)).toEqual(['monka-recap']);
  });

  it('matches multi-word probes across flexible whitespace', () => {
    createNote(tmpDir, config, 'note', 'Large Language Model', 'body text.\n', {
      extraFrontmatter: { aliases: ['foundation model'] },
    });
    createNote(tmpDir, config, 'note', 'Source Note', 'An LLM can be a foundation  model today.\n');
    const result = withDb(run => run('source-note'));
    expect(result.map(s => s.target_slug)).toEqual(['large-language-model']);
    expect(result[0].mentions).toBe(1);
  });

  it('counts distinct occurrences of a note, including its alias', () => {
    createNote(tmpDir, config, 'note', 'Large Language Model', 'body text.\n', {
      extraFrontmatter: { aliases: ['LLM'] },
    });
    createNote(tmpDir, config, 'note', 'Source Note', 'An LLM is useful. Later, LLM again.\n');
    const result = withDb(run => run('source-note'));
    expect(result[0].mentions).toBe(2);
  });
  it('counts repeated mentions of the same note', () => {
    createNote(tmpDir, config, 'note', 'Alpha', 'body text.\n');
    createNote(tmpDir, config, 'note', 'Source Note', 'Alpha plus Alpha again, and Beta once.\n');
    createNote(tmpDir, config, 'note', 'Beta', 'body text.\n');
    const result = withDb(run => run('source-note'));
    const byslug = Object.fromEntries(result.map(s => [s.target_slug, s.mentions]));
    expect(byslug.alpha).toBe(2);
    expect(byslug.beta).toBe(1);
    expect(result[0].target_slug).toBe('alpha');
  });

  it('lets the longest overlapping spelling win the shared characters', () => {
    createNote(tmpDir, config, 'note', 'Monka', 'body text.\n', { extraFrontmatter: { aliases: ['Monka.care'] } });
    createNote(tmpDir, config, 'note', 'Source Note', 'Deployed on Monka.care this week.\n');
    const result = withDb(run => run('source-note'));
    // Only one candidate may claim the overlapping span, not two.
    expect(result).toHaveLength(1);
    expect(result[0].mentions).toBe(1);
  });

  it('caps results when a limit is provided', () => {
    for (const title of ['Alpha', 'Beta', 'Gamma']) {
      createNote(tmpDir, config, 'note', title, 'body text.\n');
    }
    createNote(tmpDir, config, 'note', 'Source Note', 'Alpha and Beta and Gamma.\n');
    const limited = withDb(run => run('source-note', 2));
    expect(limited).toHaveLength(2);
    expect(limited.map(s => s.target_slug)).toEqual(['alpha', 'beta']);
  });
});
