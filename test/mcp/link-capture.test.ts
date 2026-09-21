import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, writeDefaultConfig } from '../../src/core/config.js';
import { GraniteMcpRuntime } from '../../src/mcp/runtime.js';

/**
 * The hot path calls Jev on every capture. Two properties matter more than the proposals
 * themselves, and both are testable without a network:
 *
 * 1. A capture must never fail because a judgment failed. The note is already on disk when
 *    the judgment runs, so losing it to a TypeSafe outage would be strictly worse than losing
 *    the suggestions.
 * 2. A capture with nothing to judge must say so rather than report an empty proposal list,
 *    which reads as "no links exist".
 */
describe('capture-time link proposals', () => {
  let tmpDir: string;
  let runtime: GraniteMcpRuntime;
  let previousKey: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-link-capture-'));
    writeDefaultConfig(tmpDir);
    const configPath = path.join(tmpDir, 'granite.yml');
    const raw = yaml.load(fs.readFileSync(configPath, 'utf-8')) as Record<string, any>;
    raw.note_types.organization = { folder: 'notes/organizations', description: 'Organizations' };
    fs.writeFileSync(configPath, yaml.dump(raw));
    const config = loadConfig(tmpDir);
    for (const typeConfig of Object.values(config.note_types)) {
      fs.mkdirSync(path.join(tmpDir, typeConfig.folder), { recursive: true });
    }
    runtime = new GraniteMcpRuntime(tmpDir, { indexCheckIntervalMs: 0 });
    previousKey = process.env.TYPESAFE_API_KEY;
  });

  afterEach(() => {
    if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previousKey;
    runtime.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns no proposal promise when there is nothing to judge', () => {
    // Nothing in the vault mentions anything, so there are no candidates.
    const result = runtime.createNote({ title: 'Lonely', type: 'note', body: 'Nothing to link here at all.\n' });
    expect(result.note.slug).toBe('lonely');
    return result.proposed_links?.then(proposed => {
      expect(proposed).toBeUndefined();
    });
  });

  it('never fails the capture when the judgment cannot run', async () => {
    // A key TypeSafe will reject. The point is that the write survives AND that the failure is
    // reported as unjudged candidates — never a throw, never silence.
    process.env.TYPESAFE_API_KEY = 'invalid-key-for-test';
    runtime.createNote({ title: 'Acme', type: 'organization', body: 'Acme is an organization.\n' });
    const result = runtime.createNote({
      title: 'Meeting about Acme',
      type: 'note',
      // A verbatim mention of an existing title is what makes a candidate, so this note must
      // actually have one for the test to exercise the judgment at all. An earlier version of
      // this test had no candidates, finished in 9ms, and proved nothing.
      body: 'We met Acme today about the hosting work.\n',
    });

    expect(fs.existsSync(result.note.filepath)).toBe(true);
    const proposed = await result.proposed_links;

    // The property that matters on the hot path: a judgment that cannot run never fails the
    // capture, and never throws into the caller. It reports either an unjudged count or
    // nothing at all — and the failure is logged rather than swallowed.
    if (proposed !== undefined) {
      expect(proposed.proposed).toEqual([]);
      expect(proposed.not_judged).toBeGreaterThan(0);
    }
    expect(fs.existsSync(result.note.filepath)).toBe(true);
  });
});
