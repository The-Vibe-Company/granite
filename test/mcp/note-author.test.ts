import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeDefaultConfig, loadConfig } from '../../src/core/config.js';
import { createNote, readNote } from '../../src/core/note.js';
import { parseFrontmatter, serializeFrontmatter } from '../../src/core/frontmatter.js';
import { AUTHOR_HISTORY_LIMIT } from '../../src/core/author.js';
import { GraniteMcpRuntime } from '../../src/mcp/runtime.js';

describe('mandatory note attribution', () => {
  let root: string;
  let runtime: GraniteMcpRuntime;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-author-'));
    writeDefaultConfig(root);
    runtime = new GraniteMcpRuntime(root, { indexCheckIntervalMs: 0 });
  });
  afterEach(() => { runtime.close(); fs.rmSync(root, { recursive: true, force: true }); });

  it.each([undefined, '', ' ', 'stan\n', 'stan\r', 'unknown', 'a\nsource: human', 'stan:admin', '"stan"', 'A', 'a'.repeat(65)])(
    'rejects invalid author %j without writing a note', author => {
      expect(() => runtime.createNote({ author, title: 'Rejected' })).toThrow(/author.*stan/i);
      expect(runtime.listNotes()).toEqual([]);
      expect(fs.existsSync(path.join(root, 'notes', 'rejected.md'))).toBe(false);
    },
  );

  it.each([undefined, '', ' ', 'stan\n', 'stan\r', 'unknown', 'a\nsource: human', 'stan:admin'])(
    'rejects revise author %j without changing the file', author => {
      const created = runtime.createNote({ author: 'stan', title: 'Preserved' });
      const filepath = path.join(root, loadConfig(root).note_types.note.folder, `${created.note.slug}.md`);
      const before = fs.readFileSync(filepath, 'utf8');
      expect(() => runtime.reviseNote(created.note.slug, { author, append: 'Refused' })).toThrow(/author.*stan/i);
      expect(fs.readFileSync(filepath, 'utf8')).toBe(before);
    },
  );

  it('stores creation and bounded chronological modification history, separately from source', () => {
    const created = runtime.createNote({ author: 'stan', title: 'Attributed', source: 'agent' });
    const filepath = path.join(root, loadConfig(root).note_types.note.folder, `${created.note.slug}.md`);
    let note = readNote(filepath);
    expect(note.frontmatter).toMatchObject({ creator: 'stan', last_modifier: 'stan', source: 'agent' });
    expect(note.frontmatter.author_history).toEqual([{ author: 'stan', date: note.frontmatter.created }]);
    for (let i = 0; i < AUTHOR_HISTORY_LIMIT + 2; i++) {
      runtime.reviseNote(created.note.slug, { author: `bot-${i}`, append: `Edit ${i}` });
    }
    note = readNote(filepath);
    expect(note.frontmatter.creator).toBe('stan');
    expect(note.frontmatter.last_modifier).toBe(`bot-${AUTHOR_HISTORY_LIMIT + 1}`);
    expect(note.frontmatter.source).toBe('agent');
    expect(note.frontmatter.author_history).toHaveLength(AUTHOR_HISTORY_LIMIT);
    expect(note.frontmatter.author_history.map(entry => entry.author)).toEqual(
      Array.from({ length: AUTHOR_HISTORY_LIMIT }, (_, i) => `bot-${i + 2}`),
    );
    expect(runtime.query({ where: { creator: 'stan' } }).results.map(n => n.slug)).toEqual([created.note.slug]);
    expect(runtime.query({ where: { last_modifier: `bot-${AUTHOR_HISTORY_LIMIT + 1}` } }).results.map(n => n.slug)).toEqual([created.note.slug]);
    expect(runtime.query({ where: { last_modifier: 'stan' } }).results).toEqual([]);
  });

  it('reads legacy attribution as unknown without rewriting, retaining unknown creator on revise', () => {
    const note = createNote(root, loadConfig(root), 'note', 'Legacy', 'Old body', { author: 'stan' });
    const parsed = parseFrontmatter(fs.readFileSync(note.filepath, 'utf8'));
    delete parsed.frontmatter.creator;
    delete parsed.frontmatter.last_modifier;
    delete parsed.frontmatter.author_history;
    fs.writeFileSync(note.filepath, serializeFrontmatter(parsed.frontmatter, parsed.body));
    const before = fs.readFileSync(note.filepath, 'utf8');
    runtime.close();
    runtime = new GraniteMcpRuntime(root, { indexCheckIntervalMs: 0 });
    expect(readNote(note.filepath).frontmatter).toMatchObject({ creator: 'unknown', last_modifier: 'unknown' });
    for (const field of ['creator', 'last_modifier']) {
      expect(runtime.query({ where: { [field]: 'unknown' } }).results.map(n => n.slug)).toEqual([note.slug]);
    }
    expect(fs.readFileSync(note.filepath, 'utf8')).toBe(before);
    expect(() => runtime.reviseNote(note.slug, { append: 'refused' })).toThrow(/author/i);
    expect(fs.readFileSync(note.filepath, 'utf8')).toBe(before);
    runtime.reviseNote(note.slug, { author: 'dave', append: 'Valid edit' });
    const revised = readNote(note.filepath).frontmatter;
    expect(revised).toMatchObject({ creator: 'unknown', last_modifier: 'dave' });
    expect(revised.author_history).toEqual([{ author: 'dave', date: revised.modified }]);
  });
});
