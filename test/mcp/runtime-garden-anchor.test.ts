import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, writeDefaultConfig } from '../../src/core/config.js';
import { createNote } from '../../src/core/note.js';
import { parseFrontmatter, serializeFrontmatter } from '../../src/core/frontmatter.js';
import { GraniteMcpRuntime } from '../../src/mcp/runtime.js';

describe('garden anchor proximity', () => {
  let root: string;
  let runtime: GraniteMcpRuntime | undefined;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-garden-anchor-')); });
  afterEach(() => { runtime?.close(); fs.rmSync(root, { recursive: true, force: true }); });

  it('prioritizes coup-de-pates and direct neighbours ahead of distant or tag-only peers with limit 3', () => {
    writeDefaultConfig(root);
    const config = loadConfig(root);
    for (const type of Object.values(config.note_types)) fs.mkdirSync(path.join(root, type.folder), { recursive: true });
    const add = (title: string, body: string, days: number, tags: string[] = []) => {
      const note = createNote(root, config, 'note', title, body);
      const parsed = parseFrontmatter(fs.readFileSync(note.filepath, 'utf8'));
      parsed.frontmatter.status = 'active';
      parsed.frontmatter.review_state = 'draft';
      parsed.frontmatter.modified = new Date(Date.now() - days * 86_400_000).toISOString();
      parsed.frontmatter.tags = tags;
      fs.writeFileSync(note.filepath, serializeFrontmatter(parsed.frontmatter, parsed.body));
    };
    add('Coup de Pates', 'Account overview.', 8, ['customer']);
    add('David Baranek', 'Works with [[coup-de-pates]].', 21);
    add('Account Decisions', 'Decisions for [[coup-de-pates]].', 35);
    add('Distant Work', 'Related through [[david-baranek]].', 90);
    add('Unrelated Customer', 'Same broad tag, no graph connection.', 120, ['customer']);
    runtime = new GraniteMcpRuntime(root, { indexCheckIntervalMs: 0 });
    const global = runtime.planGarden({ limit: 20 });
    expect(global.opportunities[0]?.targets[0]?.slug).not.toBe('coup-de-pates');
    const plan = runtime.planGarden({ anchor_slug: 'coup-de-pates', limit: 3 });
    expect(plan.scope.anchor_slug).toBe('coup-de-pates');
    expect(plan.opportunities.map(item => item.targets.map(target => target.slug))).toEqual([
      ['coup-de-pates'], ['account-decisions'], ['david-baranek'],
    ]);
    expect(plan.opportunities.map(item => item.evidence.metrics.anchor_distance)).toEqual([0, 1, 1]);
    expect(plan.scope.notes_considered).toBe(4);
  });
  it('keeps anchor opportunities adjudicable when a global cluster would suppress them', () => {
    writeDefaultConfig(root);
    const config = loadConfig(root);
    for (const type of Object.values(config.note_types)) fs.mkdirSync(path.join(root, type.folder), { recursive: true });
    const modified = new Date(Date.now() - 10 * 86_400_000).toISOString();
    for (const [title, body] of [
      ['Coup de Pates', 'Account overview.'],
      ['Direct Contact', 'Contact for [[coup-de-pates]].'],
      ['Global Peer', 'Broad customer cluster.'],
      ['Other Peer', 'Broad customer cluster.'],
    ]) {
      const note = createNote(root, config, 'note', title, body);
      const parsed = parseFrontmatter(fs.readFileSync(note.filepath, 'utf8'));
      parsed.frontmatter.status = 'active';
      parsed.frontmatter.review_state = 'draft';
      parsed.frontmatter.modified = modified;
      parsed.frontmatter.tags = ['customer'];
      fs.writeFileSync(note.filepath, serializeFrontmatter(parsed.frontmatter, parsed.body));
    }
    runtime = new GraniteMcpRuntime(root, { indexCheckIntervalMs: 0 });
    const plan = runtime.planGarden({ anchor_slug: 'coup-de-pates', limit: 3 });
    const opportunity = plan.opportunities.find(item => item.kind === 'draft-debt' && item.targets[0].slug === 'coup-de-pates');
    expect(opportunity).toBeDefined();
    expect(plan.opportunities.every(item => item.targets.every(target => ['coup-de-pates', 'direct-contact'].includes(target.slug)))).toBe(true);
    const adjudicated = runtime.adjudicateGardenOpportunity({ opportunity_id: opportunity!.id, decision: 'downrank', reason_code: 'low-value' });
    expect(adjudicated.opportunity_id).toBe(opportunity!.id);
    expect(adjudicated.adjudication).not.toBeNull();
  });

});
