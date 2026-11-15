import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, writeDefaultConfig } from '../../src/core/config.js';
import { createNote, listNotes, readNote } from '../../src/core/note.js';
import { ensureIndex } from '../../src/core/index-db.js';

const cli = path.resolve('src/index.ts');
const tsx = path.resolve('node_modules/tsx/dist/cli.mjs');

describe('CLI author follow-up regressions', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-author-cli-'));
    writeDefaultConfig(root);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function run(args: string[], input = '', editor?: string) {
    return spawnSync(process.execPath, [tsx, cli, ...args], {
      cwd: root, input, encoding: 'utf8',
      env: { ...process.env, TYPESAFE_API_KEY: 'test-key', ...(editor ? { EDITOR: editor } : {}) },
    });
  }

  function proposals() {
    createNote(root, loadConfig(root), 'note', 'Source Note', 'Monka uses Scaleway.', { author: 'dave' });
    return JSON.stringify([{ source: 'source-note', span: 'Monka uses Scaleway.', subject: 'Monka', relation: 'hosting', object: 'Scaleway', valid_from: '2026-06-01' }]);
  }

  it.each([{ flags: [] }, { flags: ['--author', ''] }, { flags: ['--author', 'bad: yaml'] }])('refuses facts --write without a valid author: $flags', ({ flags }) => {
    const input = proposals();
    const before = listNotes(root, loadConfig(root));
    const result = run(['facts', '--write', ...flags], input);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/author.*stan/);
    expect(listNotes(root, loadConfig(root))).toEqual(before);
    expect(fs.existsSync(path.join(root, '.granite', 'audit.jsonl'))).toBe(false);
  });

  it('accepts facts --write --author stan and stores attribution', () => {
    const result = run(['facts', '--write', '--author', 'stan', '--json'], proposals());
    expect(result.status, result.stderr).toBe(0);
    const written = JSON.parse(result.stdout).data.written;
    expect(written).toHaveLength(1);
    const fact = listNotes(root, loadConfig(root)).find(note => note.slug === written[0])!;
    expect(fact.frontmatter).toMatchObject({ creator: 'stan', last_modifier: 'stan', author_history: [{ author: 'stan', date: expect.any(String) }] });
  });

  it('keeps fact read and dry-run paths author-free', () => {
    const input = proposals();
    expect(run(['facts', '--json']).status).toBe(0);
    const planned = run(['facts', '--write', '--dry-run', '--json'], input);
    expect(planned.status, planned.stderr).toBe(0);
    expect(JSON.parse(planned.stdout).data.written).toHaveLength(1);
    expect(listNotes(root, loadConfig(root))).toHaveLength(1);
  });

  it.each(['edit', 'open'])('attributes a saved note even when %s editor exits nonzero', command => {
    const config = loadConfig(root);
    const note = createNote(root, config, 'note', 'Edited', 'Original body', { author: 'dave' });
    const script = path.join(root, 'save-then-fail.cjs');
    fs.writeFileSync(script, `const fs = require('node:fs'); const p = process.argv[2]; fs.appendFileSync(p, '\\nSaved despite failure\\n'); process.exit(7);`);
    const result = run([command, note.slug, '--author', 'stan'], '', `${process.execPath} ${script}`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Editor exited unsuccessfully');
    const updated = readNote(note.filepath);
    expect(updated.body).toContain('Saved despite failure');
    expect(updated.frontmatter.creator).toBe('dave');
    expect(updated.frontmatter.last_modifier).toBe('stan');
    expect(updated.frontmatter.author_history).toEqual([
      { author: 'dave', date: note.frontmatter.created },
      { author: 'stan', date: updated.frontmatter.modified },
    ]);
    const db = ensureIndex(root, { ...config, index: { auto_rebuild: false } });
    try {
      expect(db.prepare('SELECT body FROM notes WHERE slug = ?').get(note.slug)).toMatchObject({ body: expect.stringContaining('Saved despite failure') });
      expect(db.prepare("SELECT field_value FROM note_fields WHERE slug = ? AND field_name = 'last_modifier'").get(note.slug)).toEqual({ field_value: 'stan' });
    } finally { db.close(); }
  });
});
