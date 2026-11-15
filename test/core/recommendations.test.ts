import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeDefaultConfig, loadConfig } from '../../src/core/config.js';
import { parseFrontmatter, serializeFrontmatter } from '../../src/core/frontmatter.js';
import { createDatabase, rebuildIndex } from '../../src/core/index-db.js';
import { createNote, readNote } from '../../src/core/note.js';
import { formatRecommendations, getRecommendations, recommendNote } from '../../src/core/recommendations.js';
import type { GraniteConfig } from '../../src/core/types.js';

describe('recommendations', () => {
  let tmpDir: string;
  let config: GraniteConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-reco-'));
    writeDefaultConfig(tmpDir);
    config = loadConfig(tmpDir);

    for (const tc of Object.values(config.note_types)) {
      fs.mkdirSync(path.join(tmpDir, tc.folder), { recursive: true });
    }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('recommends linked notes, tags, and a next step from local context', () => {
    const source = createNote(tmpDir, config, 'source', 'Attention Is All You Need', 'Transformer source note.\n', { author: 'stan' });
    setTags(source.filepath, ['transformers', 'attention']);

    const synthesis = createNote(tmpDir, config, 'synthesis', 'Transformer Architecture', 'Compiled view of transformers.\n', { author: 'stan' });
    setTags(synthesis.filepath, ['transformers', 'architecture']);

    const note = createNote(
      tmpDir,
      config,
      'source',
      'Scaling source',
      'Transformer architecture and attention patterns matter for scaling.\n',
    { author: 'stan' });

    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    rebuildIndex(tmpDir, config, db);

    const recommendations = getRecommendations(db, readNote(note.filepath), config);
    db.close();

    expect(recommendations.links.map(link => link.slug)).toEqual(
      expect.arrayContaining(['attention-is-all-you-need', 'transformer-architecture']),
    );
    expect(recommendations.links.some(link => link.reason.includes('mentioned') || link.source === 'search')).toBe(true);
    expect(recommendations.additions.map(item => item.text)).toEqual(
      expect.arrayContaining([
        'Write a short summary so this source is understandable without rereading the whole document.',
        'Capture 2-3 concrete facts worth preserving from the source.',
      ]),
    );
    expect(recommendations.tags.map(tag => tag.tag)).toEqual(
      expect.arrayContaining(['transformers', 'attention']),
    );
    expect(recommendations.next_steps[0]).toMatchObject({
      type: 'synthesis',
      title_hint: 'Scaling source synthesis',
    });
  });

  it('recommends related notes through local search when no title is mentioned exactly', () => {
    const source = createNote(
      tmpDir,
      config,
      'source',
      'Semantic Search Source',
      'Semantic retrieval helps a note system find related ideas.\n',
    { author: 'stan' });
    setTags(source.filepath, ['search']);

    const synthesis = createNote(
      tmpDir,
      config,
      'synthesis',
      'Embeddings for Notes',
      'Vector retrieval improves knowledge discovery in a note vault.\n',
    { author: 'stan' });
    setTags(synthesis.filepath, ['embeddings']);

    const target = createNote(
      tmpDir,
      config,
      'note',
      'Semantic retrieval for a vault',
      'A local note system should surface related knowledge quickly.\n',
    { author: 'stan' });

    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    rebuildIndex(tmpDir, config, db);

    const recommendations = getRecommendations(db, readNote(target.filepath), config);
    db.close();

    expect(recommendations.links.some(link => link.source === 'search')).toBe(true);
    expect(recommendations.links.map(link => link.slug)).toEqual(
      expect.arrayContaining(['semantic-search-source', 'embeddings-for-notes']),
    );
    expect(recommendations.tags.map(tag => tag.tag)).toContain('search');
  });

  it('does not re-suggest notes that are already linked', () => {
    createNote(tmpDir, config, 'source', 'Attention Source', 'Core source.\n', { author: 'stan' });
    const launch = createNote(
      tmpDir,
      config,
      'note',
      'Launch note',
      'We should revisit [[Attention Source]] before publishing.\n',
    { author: 'stan' });

    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    rebuildIndex(tmpDir, config, db);

    const recommendations = getRecommendations(db, readNote(launch.filepath), config);
    db.close();

    expect(recommendations.links.map(link => link.slug)).not.toContain('attention-source');
  });

  it('formats recommendation sections and returns nothing when empty', () => {
    expect(formatRecommendations({
      additions: [],
      links: [],
      tags: [],
      next_steps: [],
    })).toEqual([]);

    expect(formatRecommendations({
      additions: [{ text: 'Add context.' }],
      links: [{ slug: 'granite', title: 'Granite', type: 'synthesis', reason: 'mentioned 2 times', source: 'mention' }],
      tags: [{ tag: 'search', weight: 3, source_slugs: ['granite', 'notes'] }],
      next_steps: [{ type: 'output', title_hint: 'Granite brief', reason: 'Create a situational deliverable.' }],
    })).toEqual([
      '  Add now:',
      '    Add context.',
      '  Link now:',
      '    [[granite]] — mentioned 2 times',
      '  Tag now:',
      '    search — seen on 2 nearby notes',
      '  Next note:',
      '    output — Create a situational deliverable. Title hint: Granite brief.',
    ]);
  });

  it('covers next-step and add-now branches for the default knowledge-oriented types', () => {
    const note = createNote(tmpDir, config, 'note', 'Memory Graph', undefined, { author: 'stan' });
    const source = createNote(tmpDir, config, 'source', 'Attention Paper', undefined, { author: 'stan' });
    const synthesis = createNote(tmpDir, config, 'synthesis', 'Transformer State', undefined, { author: 'stan' });
    const output = createNote(tmpDir, config, 'output', 'Team Brief', undefined, { author: 'stan' });

    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    rebuildIndex(tmpDir, config, db);

    const noteRecommendations = getRecommendations(db, readNote(note.filepath), config);
    expect(noteRecommendations.additions.map(item => item.text)).toEqual(
      expect.arrayContaining([
        'Write a one-line summary before expanding the idea.',
        'Link one source, synthesis, or adjacent durable idea.',
      ]),
    );
    expect(noteRecommendations.next_steps[0].type).toBe('source');

    const sourceRecommendations = getRecommendations(db, readNote(source.filepath), config);
    expect(sourceRecommendations.additions.map(item => item.text)).toEqual(
      expect.arrayContaining([
        'Write a short summary so this source is understandable without rereading the whole document.',
        'Capture 2-3 concrete facts worth preserving from the source.',
        'Link one note or synthesis that this source supports.',
      ]),
    );
    expect(sourceRecommendations.next_steps[0].type).toBe('synthesis');

    const synthesisRecommendations = getRecommendations(db, readNote(synthesis.filepath), config);
    expect(synthesisRecommendations.additions.map(item => item.text)).toEqual(
      expect.arrayContaining([
        'Define the scope so this synthesis has a clear boundary.',
        'Write a short executive summary before expanding the synthesis.',
        'Link the notes or sources this synthesis pulls together.',
      ]),
    );
    expect(synthesisRecommendations.next_steps[0].type).toBe('output');

    const outputRecommendations = getRecommendations(db, readNote(output.filepath), config);
    expect(outputRecommendations.additions.map(item => item.text)).toEqual(
      expect.arrayContaining([
        'State the goal so the output is grounded in a concrete need.',
        'Name the audience so the tone and content stay focused.',
        'Link the source note or synthesis this output derives from.',
      ]),
    );
    expect(outputRecommendations.next_steps[0].type).toBe('synthesis');

    db.close();
  });

  it('supports incremental recommendation refreshes', () => {
    createNote(tmpDir, config, 'synthesis', 'Granite', 'Local-first system.\n', { author: 'stan' });
    const note = createNote(
      tmpDir,
      config,
      'source',
      'Fresh note',
      'Granite keeps markdown notes portable.\n',
    { author: 'stan' });

    const recommendations = recommendNote(tmpDir, config, readNote(note.filepath), {
      strategy: 'incremental',
    });

    expect(recommendations.links.some(link => link.slug === 'granite')).toBe(true);
  });
});

function setTags(filepath: string, tags: string[]): void {
  const content = fs.readFileSync(filepath, 'utf-8');
  const { frontmatter, body } = parseFrontmatter(content);
  frontmatter.tags = tags;
  frontmatter.modified = new Date().toISOString();
  fs.writeFileSync(filepath, serializeFrontmatter(frontmatter, body), 'utf-8');
}
