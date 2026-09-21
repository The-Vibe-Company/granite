import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeDefaultConfig } from '../../src/core/config.js';
import { aboutCommand } from '../../src/commands/about.js';

/**
 * These tests drive the real command against a real temporary vault.
 *
 * An earlier version of this coverage re-implemented the flag guards in a local `select()`
 * helper, so it asserted that a copy of the logic behaved — a regression in `aboutCommand`
 * itself would still have passed. Everything here goes through the exported command.
 */
describe('aboutCommand', () => {
  let vault: string;
  let previousCwd: string;

  const write = (folder: string, slug: string, type: string, body: string): void => {
    fs.mkdirSync(path.join(vault, folder), { recursive: true });
    fs.writeFileSync(
      path.join(vault, folder, `${slug}.md`),
      [
        '---',
        `id: ${randomUUID()}`,
        `title: ${slug}`,
        `type: ${type}`,
        'status: active',
        '---',
        '',
        body,
        '',
      ].join('\n'),
      'utf-8',
    );
  };

  const run = (options: Parameters<typeof aboutCommand>[1], slug = 'monka-care'): string => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    aboutCommand(slug, options);
    const out = log.mock.calls.map(call => String(call[0])).join('\n');
    log.mockRestore();
    return out;
  };

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-about-cmd-'));
    previousCwd = process.cwd();
    process.chdir(vault);
    writeDefaultConfig(vault);
    // Two meetings, one person and one note reference the entity; the entity itself links
    // out to one partner. The groups are deliberately uneven so a filtered count is
    // distinguishable from the unfiltered total.
    write(
      'notes/notes',
      'monka-care',
      'organization',
      'Monka.care operates in France and works with [[partner-org]].',
    );
    write('notes/notes', 'partner-org', 'organization', 'A hosting partner.');
    write('notes/notes', 'hds-note', 'note', 'Hosting compliance work for [[Monka.care]].');
    write('notes/notes', 'meeting-a', 'meeting', 'Kickoff with [[Monka.care]] covering scope.');
    write('notes/notes', 'meeting-b', 'meeting', 'Follow-up with [[Monka.care]] on pricing.');
    write('notes/notes', 'person-a', 'person', 'Étienne Rubi sponsors [[Monka.care]].');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.chdir(previousCwd);
    fs.rmSync(vault, { recursive: true, force: true });
  });

  it('renders both sections when neither flag is given', () => {
    const out = run({});
    expect(out).toContain('Referenced by');
    expect(out).toContain('References');
  });

  it('renders both sections when both flags are given', () => {
    const out = run({ incoming: true, outgoing: true });
    expect(out).toContain('Referenced by');
    expect(out).toContain('References');
  });

  it('renders only the incoming section when only --incoming is given', () => {
    const out = run({ incoming: true });
    expect(out).toContain('Referenced by');
    expect(out).not.toContain('References');
  });

  it('renders only the outgoing section when only --outgoing is given', () => {
    const out = run({ outgoing: true });
    expect(out).not.toContain('Referenced by');
    expect(out).toContain('References');
  });

  it('reports counts that match the groups actually rendered after --type filters', () => {
    const unfiltered = JSON.parse(run({ json: true }));
    const filtered = JSON.parse(run({ json: true, types: ['meeting'] }));

    const sum = (groups: Record<string, unknown[]>) =>
      Object.values(groups).reduce((total: number, list) => total + list.length, 0);

    // The bug this pins: the header counts came from the unfiltered entity, so a filtered
    // view announced more notes than it then showed.
    expect(filtered.data.counts.incoming).toBe(sum(filtered.data.incoming));
    expect(sum(filtered.data.incoming)).toBeLessThan(unfiltered.data.counts.incoming);
    expect(filtered.data.counts.incoming).toBeGreaterThan(0);
  });

  it('does not claim the entity is unreferenced when only the filter is empty', () => {
    // The entity has four referrers; none of them is a "source". Saying "nothing links to
    // this note" would be false, and it is the kind of falsehood a reader acts on. This
    // asserts the human output, where the message is printed — `--json` returns the counts
    // and never reaches it.
    const out = run({ types: ['source'] });
    expect(out).not.toContain('Nothing links to this note');
    expect(out).toContain('No source note references this one');
  });

  it('prints the filtered counts when the requested type is present', () => {
    const out = run({ types: ['meeting'] });
    expect(out).not.toContain('No meeting note references this one');
    expect(out).toContain('2 note(s) link here');
  });

  it('still reports a genuinely unreferenced entity as such', () => {
    write('notes/notes', 'lonely-org', 'organization', 'An entity nothing points at.');
    expect(run({}, 'lonely-org')).toContain('Nothing links to this note');
  });});
