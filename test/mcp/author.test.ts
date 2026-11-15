import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeDefaultConfig } from '../../src/core/config.js';
import { GraniteMcpRuntime } from '../../src/mcp/runtime.js';

describe('mandatory note authors across MCP writes', () => {
  let root: string;
  let runtime: GraniteMcpRuntime;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-authors-'));
    writeDefaultConfig(root);
    runtime = new GraniteMcpRuntime(root, { indexCheckIntervalMs: 0 });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { runtime.close(); fs.rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it.each([undefined, '', ' ', 'bad\nsource: human', 'unknown', 'Stan', 'a'.repeat(65)])('rejects invalid author %j without a note write', author => {
    expect(() => runtime.createNote({ author, title: 'Rejected' })).toThrow(/author.*stan/);
    expect(runtime.listNotes()).toHaveLength(0);
  });

  it('tracks creator, last modifier and bounded history while preserving source', () => {
    const created = runtime.createNote({ author: 'stan', title: 'Authorship', source: 'human' });
    expect(created.note.frontmatter).toMatchObject({ creator: 'stan', last_modifier: 'stan', source: 'human', author_history: [{ author: 'stan', date: expect.any(String) }] });
    expect(() => runtime.reviseNote(created.note.slug, { append: 'rejected' })).toThrow(/author/);
    for (let i = 0; i < 12; i++) runtime.reviseNote(created.note.slug, { author: `bot-${i}`, append: 'change' });
    const note = runtime.getNote(created.note.slug);
    expect(note.frontmatter.creator).toBe('stan');
    expect(note.frontmatter.last_modifier).toBe('bot-11');
    expect(note.frontmatter.source).toBe('human');
    const history = note.frontmatter.author_history as { author: string; date: string }[];
    expect(history).toHaveLength(10);
    expect(history[0].author).toBe('bot-2');
    expect(history[9].author).toBe('bot-11');
    expect(runtime.query({ creator: 'stan' }).results.map(n => n.slug)).toContain(note.slug);
    expect(runtime.query({ last_modifier: 'bot-11' }).results.map(n => n.slug)).toContain(note.slug);
  });

  it('reads legacy attribution as unknown without writing and preserves unknown creator on revise', () => {
    const created = runtime.createNote({ author: 'stan', title: 'Legacy' });
    const file = created.note.filepath;
    const raw = fs.readFileSync(file, 'utf8');
    // Strip attribution only, leaving a genuine legacy markdown note.
    const legacy = raw.replace(/^creator:.*\n/m, '').replace(/^last_modifier:.*\n/m, '').replace(/^author_history:\n(?:[ \t].*\n)*/m, '');
    fs.writeFileSync(file, legacy);
    expect(runtime.getNote(created.note.slug).creator).toBe('unknown');
    expect(runtime.query({ creator: 'unknown', last_modifier: 'unknown' }).results.map(n => n.slug)).toContain(created.note.slug);
    expect(fs.readFileSync(file, 'utf8')).toBe(legacy);
    runtime.reviseNote(created.note.slug, { author: 'dave', append: 'new work' });
    expect(runtime.getNote(created.note.slug).frontmatter).toMatchObject({ creator: 'unknown', last_modifier: 'dave', author_history: [{ author: 'dave', date: expect.any(String) }] });
  });
});
