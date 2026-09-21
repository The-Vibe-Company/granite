import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('reports the candidates it could not judge when Jev fails, and keeps the note', async () => {
    // `fetch` is stubbed: the suite must not depend on the network, and the point here is the
    // failure path. An earlier version of this test called TypeSafe for real, took 593ms, and
    // still passed while a wrong note shape made the whole judgment throw before it ran.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"detail":"nope"}', { status: 401 }),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      runtime.createNote({ title: 'Acme', type: 'organization', body: 'Acme is an organization.\n' });
      const result = runtime.createNote({
        title: 'Meeting about Acme',
        type: 'note',
        // A verbatim mention of an existing title is what makes a candidate. Without one this
        // test exercises nothing.
        body: 'We met Acme today about the hosting work.\n',
      });

      expect(fs.existsSync(result.note.filepath)).toBe(true);
      const proposed = await result.proposed_links;

      // The judgment ran and failed: the candidates are reported unjudged, not silently dropped.
      expect(proposed).toBeDefined();
      expect(proposed!.proposed).toEqual([]);
      expect(proposed!.not_judged).toBeGreaterThan(0);
      // The failure is logged, never swallowed.
      expect(errorSpy).toHaveBeenCalled();
      // And the note survived, which is the property that matters on the hot path.
      expect(fs.existsSync(result.note.filepath)).toBe(true);
    } finally {
      fetchSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('proposes the link when Jev accepts it', async () => {
    // The success path, with the network stubbed. This is what catches a wrong shape passed to
    // the candidate builder: the previous version of the suite passed while that threw.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ answers: { 'link::acme': { type: 'noul', noul: 0.97 } } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    try {
      runtime.createNote({ title: 'Acme', type: 'organization', body: 'Acme is an organization.\n' });
      const result = runtime.createNote({
        title: 'Meeting about Acme',
        type: 'note',
        body: 'We met Acme today about the hosting work.\n',
      });
      const proposed = await result.proposed_links;
      expect(proposed).toBeDefined();
      expect(proposed!.proposed).toHaveLength(1);
      expect(proposed!.proposed[0]).toMatchObject({ target: 'acme', link_probability: 0.97 });
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
