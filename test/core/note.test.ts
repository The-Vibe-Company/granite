import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNote, readNote, listNotes, findNoteBySlug } from '../../src/core/note.js';
import { writeDefaultConfig, loadConfig } from '../../src/core/config.js';
import type { GraniteConfig } from '../../src/core/types.js';

describe('note', () => {
  let tmpDir: string;
  let config: GraniteConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-note-'));
    writeDefaultConfig(tmpDir);
    config = loadConfig(tmpDir);
    // Create type folders
    for (const tc of Object.values(config.note_types)) {
      fs.mkdirSync(path.join(tmpDir, tc.folder), { recursive: true });
    }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a note with correct frontmatter', () => {
    const note = createNote(tmpDir, config, 'note', 'My Test Note', undefined, { author: 'stan' });
    expect(note.slug).toBe('my-test-note');
    expect(note.frontmatter.title).toBe('My Test Note');
    expect(note.frontmatter.type).toBe('note');
    expect(note.frontmatter.id).toBeTruthy();
    expect(note.frontmatter.review_state).toBe('draft');
    expect(note.frontmatter.durability).toBe('canonical');
    expect(note.frontmatter.derived_from).toEqual([]);
    expect(fs.existsSync(note.filepath)).toBe(true);
  });

  it('creates a default note with title-based slug', () => {
    const note = createNote(tmpDir, config, 'note', 'Quick thought', undefined, { author: 'stan' });
    expect(note.slug).toBe('quick-thought');
    expect(note.frontmatter.title).toBe('Quick thought');
    expect(note.frontmatter.type).toBe('note');
    expect(note.frontmatter.durability).toBe('canonical');
  });

  it('creates a note with custom body', () => {
    const note = createNote(tmpDir, config, 'note', 'Quick', 'Custom body text\n', { author: 'stan' });
    expect(note.body).toBe('Custom body text\n');
  });

  it('normalizes invalid frontmatter defaults from config', () => {
    config.note_types.note.frontmatter_defaults = {
      status: 'bad-status' as any,
      source: 'bad-source' as any,
      review_state: 'bad-review' as any,
      durability: 'bad-durability' as any,
      derived_from: 'bad-derived' as any,
    };

    const note = createNote(tmpDir, config, 'note', 'Normalized Defaults', undefined, { author: 'stan' });
    expect(note.frontmatter.status).toBe('active');
    expect(note.frontmatter.source).toBe('human');
    expect(note.frontmatter.review_state).toBe('draft');
    expect(note.frontmatter.durability).toBe('working');
    expect(note.frontmatter.derived_from).toEqual([]);
  });

  it('handles slug collision', () => {
    const note1 = createNote(tmpDir, config, 'note', 'Duplicate', undefined, { author: 'stan' });
    const note2 = createNote(tmpDir, config, 'note', 'Duplicate', undefined, { author: 'stan' });
    expect(note1.slug).toBe('duplicate');
    expect(note2.slug).toBe('duplicate-2');
  });

  it('throws for unknown note type', () => {
    expect(() => createNote(tmpDir, config, 'unknown', 'Test', undefined, { author: 'stan' })).toThrow('Unknown note type');
  });

  it('reads a note back correctly', () => {
    const created = createNote(tmpDir, config, 'note', 'Readable', undefined, { author: 'stan' });
    const read = readNote(created.filepath);
    expect(read.slug).toBe('readable');
    expect(read.frontmatter.title).toBe('Readable');
    expect(read.frontmatter.type).toBe('note');
  });

  it('lists all notes across types', () => {
    createNote(tmpDir, config, 'note', 'Note A', undefined, { author: 'stan' });
    createNote(tmpDir, config, 'note', 'Note B', undefined, { author: 'stan' });
    createNote(tmpDir, config, 'source', 'Note C', undefined, { author: 'stan' });
    const notes = listNotes(tmpDir, config);
    expect(notes).toHaveLength(3);
  });

  it('finds a note by slug', () => {
    createNote(tmpDir, config, 'note', 'Findable Note', undefined, { author: 'stan' });
    const found = findNoteBySlug(tmpDir, config, 'findable-note');
    expect(found).not.toBeNull();
    expect(found!.frontmatter.title).toBe('Findable Note');
  });

  it('returns null for non-existent slug', () => {
    const found = findNoteBySlug(tmpDir, config, 'does-not-exist');
    expect(found).toBeNull();
  });
});
