import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeDefaultConfig, loadConfig } from '../../src/core/config.js';
import { parseFrontmatter, serializeFrontmatter } from '../../src/core/frontmatter.js';
import { getGardenAdjudicationsPath } from '../../src/core/garden-adjudications.js';
import { createNote } from '../../src/core/note.js';
import type { GraniteConfig } from '../../src/core/types.js';
import { GraniteMcpRuntime } from '../../src/mcp/runtime.js';
import { createDocxFixture } from '../helpers/document-fixtures.js';

describe('GraniteMcpRuntime', () => {
  let tmpDir: string;
  let config: GraniteConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-runtime-'));
    writeDefaultConfig(tmpDir);
    config = loadConfig(tmpDir);

    for (const typeConfig of Object.values(config.note_types)) {
      fs.mkdirSync(path.join(tmpDir, typeConfig.folder), { recursive: true });
    }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('bootstraps a missing index with auto_rebuild disabled, then respects manual indexing on restart', () => {
    createNote(tmpDir, config, 'note', 'Migrated Knowledge', 'Portable knowledge.\n');
    const configPath = path.join(tmpDir, 'granite.yml');
    const manualConfig = fs.readFileSync(configPath, 'utf8').replace('auto_rebuild: true', 'auto_rebuild: false');
    fs.writeFileSync(configPath, manualConfig);

    let runtime = new GraniteMcpRuntime(tmpDir, { indexCheckIntervalMs: 0 });
    try {
      expect(runtime.search('portable')).toHaveLength(1);
      expect(fs.readFileSync(configPath, 'utf8')).toBe(manualConfig);
    } finally { runtime.close(); }

    createNote(tmpDir, config, 'note', 'Later External Note', 'Unindexed addition.\n');
    runtime = new GraniteMcpRuntime(tmpDir, { indexCheckIntervalMs: 0 });
    try {
      expect(runtime.search('portable')).toHaveLength(1);
      expect(runtime.search('unindexed')).toHaveLength(0);
    } finally { runtime.close(); }
  });

  it('rebuilds a stale index on first refresh after a note deletion', () => {
    createNote(tmpDir, config, 'note', 'Stable Note', 'Persistent note.\n');
    const deleted = createNote(tmpDir, config, 'note', 'Deleted Note', 'Unique deleted content.\n');

    let runtime = new GraniteMcpRuntime(tmpDir, { indexCheckIntervalMs: 0 });
    expect(runtime.search('deleted')).toHaveLength(1);
    runtime.close();

    fs.unlinkSync(deleted.filepath);

    runtime = new GraniteMcpRuntime(tmpDir, { indexCheckIntervalMs: 0 });
    expect(runtime.search('deleted')).toHaveLength(0);
    runtime.close();
  });

  it('preserves created and modified timestamps when no metadata mutations are requested', () => {
    const runtime = new GraniteMcpRuntime(tmpDir, { indexCheckIntervalMs: 0 });
    const result = runtime.createNote({
      title: 'Fresh Note',
      type: 'note',
      body: 'No extra metadata.\n',
    });

    expect(result.note.frontmatter.created).toBe(result.note.frontmatter.modified);
    runtime.close();
  });

  it('revises a note type and keeps it addressable by slug', () => {
    const runtime = new GraniteMcpRuntime(tmpDir, { indexCheckIntervalMs: 0 });
    const created = runtime.createNote({
      title: 'Type Promotion',
      type: 'note',
      body: 'Promote me.\n',
    });

    const revised = runtime.reviseNote(created.note.slug, { type: 'source' });

    expect(revised.note.type).toBe('source');
    expect(revised.note.slug).toBe(created.note.slug);
    runtime.close();
  });

  it('deletes a note and removes it from search', () => {
    const runtime = new GraniteMcpRuntime(tmpDir, { indexCheckIntervalMs: 0 });
    const created = runtime.createNote({
      title: 'Disposable',
      type: 'note',
      body: 'Delete me from the index.\n',
    });

    expect(runtime.search('delete')).toHaveLength(1);

    const disposed = runtime.disposeNote(created.note.slug, 'delete');

    expect(disposed.note).toBeNull();
    expect(runtime.search('delete')).toHaveLength(0);
    runtime.close();
  });

  it('imports a document with provided content and exposes the linked asset resource', () => {
    const runtime = new GraniteMcpRuntime(tmpDir, { indexCheckIntervalMs: 0 });
    const inputFile = path.join(tmpDir, 'design-brief.pdf');
    fs.writeFileSync(inputFile, '%PDF-1.4\nbrief\n');

    const imported = runtime.importDocument({
      file_path: inputFile,
      content: 'Design brief for the Q2 launch.\n- Audience: founders\n- Goal: clarify positioning',
    });

    expect(imported.note.type).toBe('source');
    expect(imported.note.status).toBe('inbox');
    expect(imported.note.source).toBe('extraction');
    expect(imported.note.frontmatter.document_file).toBe(imported.document.file);
    expect(imported.document.resource_uri).toBe(`granite://assets/${encodeURIComponent(imported.document.file)}`);
    expect(imported.note.body).toContain('## Content');
    expect(imported.note.body).toContain('Design brief for the Q2 launch.');

    const asset = runtime.readAsset(imported.document.file);
    expect('blob' in asset).toBe(true);
    expect(asset.mimeType).toBe('application/pdf');
    runtime.close();
  });

  it('extracts a DOCX through the runtime without creating notes', async () => {
    const runtime = new GraniteMcpRuntime(tmpDir, { indexCheckIntervalMs: 0 });
    const inputFile = path.join(tmpDir, 'runtime.docx');
    createDocxFixture(inputFile, ['Runtime extraction works']);

    const before = runtime.listNotes({ limit: 20 }).length;
    const extracted = await runtime.extractDocument({ file_path: inputFile });
    const after = runtime.listNotes({ limit: 20 }).length;

    expect(extracted.status).toBe('ready');
    expect(extracted.doc_type).toBe('docx');
    expect(extracted.raw_text).toContain('Runtime extraction works');
    expect(after).toBe(before);
    runtime.close();
  });

  it('plans garden opportunities globally and around an anchor note', () => {
    const runtime = new GraniteMcpRuntime(tmpDir, { indexCheckIntervalMs: 0 });
    const anchor = runtime.createNote({
      title: 'Garden Anchor',
      type: 'note',
      body: 'Anchor note for Granite planning.\n',
      tags: ['granite-vision'],
    });
    const updateA = runtime.createNote({
      title: 'Granite Update A',
      type: 'note',
      body: 'Fresh note that links [[Garden Anchor]].\n',
      tags: ['granite-vision'],
    });
    const updateB = runtime.createNote({
      title: 'Granite Update B',
      type: 'note',
      body: 'Another fresh note about Granite.\n',
      tags: ['granite-vision'],
    });
    const synthesis = runtime.createNote({
      title: 'Garden Synthesis',
      type: 'synthesis',
      body: 'Old synthesis for [[Garden Anchor]].\n',
      tags: ['granite-vision'],
      derived_from: [anchor.note.slug],
    });
    const source = runtime.createNote({
      title: 'Uncompiled Source',
      type: 'source',
      body: 'Raw source material waiting to be distilled.\n',
      tags: ['granite-vision'],
    });

    rewriteNoteTimestamps(anchor.note.filepath, { modified: isoDaysAgo(25) });
    rewriteNoteTimestamps(updateA.note.filepath, { modified: isoDaysAgo(1) });
    rewriteNoteTimestamps(updateB.note.filepath, { modified: isoDaysAgo(2) });
    rewriteNoteTimestamps(synthesis.note.filepath, { modified: isoDaysAgo(30) });
    rewriteNoteTimestamps(source.note.filepath, { modified: isoDaysAgo(20) });

    const globalPlan = runtime.planGarden({ limit: 10 });
    expect(globalPlan.scope.kind).toBe('vault');
    expect(globalPlan.opportunities.some(item => item.kind === 'stale-synthesis')).toBe(true);
    expect(globalPlan.opportunities.some(item => item.kind === 'source-not-compiled')).toBe(true);

    const anchorPlan = runtime.planGarden({
      anchor_slug: anchor.note.slug,
      limit: 3,
    });
    expect(anchorPlan.scope.kind).toBe('anchor');
    expect(anchorPlan.scope.anchor_slug).toBe(anchor.note.slug);
    expect(anchorPlan.scope.notes_considered).toBeGreaterThan(1);
    expect(anchorPlan.opportunities.length).toBeLessThanOrEqual(3);
    expect(anchorPlan.opportunities.some(item => item.targets.some(target => target.slug === synthesis.note.slug || target.slug === source.note.slug))).toBe(true);
    runtime.close();
  });

  it('does not mark scoped child notes as duplicates based on title containment alone', () => {
    const runtime = new GraniteMcpRuntime(tmpDir, { indexCheckIntervalMs: 0 });
    const hub = runtime.createNote({
      title: 'Granite',
      type: 'note',
      body: 'Hub note for Granite.\n',
      tags: ['granite-vision'],
    });
    const child = runtime.createNote({
      title: "Granite as Karpathy's knowledge compiler",
      type: 'note',
      body: 'A scoped elaboration of the Granite idea.\n',
      tags: ['granite-vision'],
    });

    const plan = runtime.planGarden({ limit: 10 });

    expect(plan.opportunities.some(item =>
      item.kind === 'duplicate-pair'
      && item.targets.some(target => target.slug === hub.note.slug)
      && item.targets.some(target => target.slug === child.note.slug),
    )).toBe(false);
    runtime.close();
  });

  it('does not propose a synthesis for the synthetic misc cluster', () => {
    const runtime = new GraniteMcpRuntime(tmpDir, { indexCheckIntervalMs: 0 });
    runtime.createNote({
      title: 'Warehouse Lease',
      type: 'note',
      body: 'Lease terms for the warehouse.\n',
    });
    runtime.createNote({
      title: 'Founder Coffee Notes',
      type: 'note',
      body: 'Notes from coffee with a founder.\n',
    });
    runtime.createNote({
      title: 'Launch Checklist',
      type: 'note',
      body: 'Checklist for the product launch.\n',
    });
    runtime.createNote({
      title: 'Tax Reminder',
      type: 'note',
      body: 'Remember the quarterly tax filing.\n',
    });

    const plan = runtime.planGarden({ limit: 10 });

    expect(plan.opportunities.some(item => item.kind === 'missing-synthesis-cluster')).toBe(false);
    runtime.close();
  });

  it('keeps anchor-scoped garden plans from pulling in foreign cluster work', () => {
    const runtime = new GraniteMcpRuntime(tmpDir, { indexCheckIntervalMs: 0 });
    const anchor = runtime.createNote({
      title: 'Anchor Note',
      type: 'note',
      body: 'Track follow-up with [[Foreign Cluster A]].\n',
      tags: ['alpha'],
    });
    runtime.createNote({
      title: 'Foreign Cluster A',
      type: 'note',
      body: 'Part of a separate beta cluster.\n',
      tags: ['beta'],
    });
    runtime.createNote({
      title: 'Foreign Cluster B',
      type: 'note',
      body: 'Another beta cluster note.\n',
      tags: ['beta'],
    });
    runtime.createNote({
      title: 'Foreign Cluster C',
      type: 'note',
      body: 'Another beta cluster note.\n',
      tags: ['beta'],
    });
    runtime.createNote({
      title: 'Foreign Cluster D',
      type: 'note',
      body: 'Another beta cluster note.\n',
      tags: ['beta'],
    });

    const plan = runtime.planGarden({
      anchor_slug: anchor.note.slug,
      limit: 10,
    });
    const outOfScopeTargets = new Set([
      'foreign-cluster-b',
      'foreign-cluster-c',
      'foreign-cluster-d',
    ]);

    expect(plan.opportunities.some(item =>
      item.targets.some(target => outOfScopeTargets.has(target.slug)),
    )).toBe(false);
    runtime.close();
  });

  it('downranks adjudicated opportunities and persists them across runtime restarts', () => {
    let runtime = new GraniteMcpRuntime(tmpDir, { indexCheckIntervalMs: 0 });
    const topic = runtime.createNote({
      title: 'Garden Topic Hub',
      type: 'note',
      body: 'Anchor note for a duplicated topic.\n',
      tags: ['granite-vision'],
    });
    const update = runtime.createNote({
      title: 'Garden Update',
      type: 'note',
      body: 'Fresh update linked to [[Garden Topic Hub]].\n',
      tags: ['granite-vision'],
    });
    const synthesis = runtime.createNote({
      title: 'Garden Topic Hub synthesis',
      type: 'synthesis',
      body: 'Old synthesis for [[Garden Topic Hub]].\n',
      tags: ['granite-vision'],
      derived_from: [topic.note.slug],
    });

    rewriteNoteTimestamps(topic.note.filepath, { modified: isoDaysAgo(25) });
    rewriteNoteTimestamps(update.note.filepath, { modified: isoDaysAgo(1) });
    rewriteNoteTimestamps(synthesis.note.filepath, { modified: isoDaysAgo(30) });

    const before = runtime.planGarden({ limit: 10 });
    expect(before.opportunities[0]?.kind).toBe('duplicate-pair');

    const adjudicated = runtime.adjudicateGardenOpportunity({
      opportunity_id: before.opportunities[0]!.id,
      decision: 'downrank',
      reason_code: 'intentional-structure',
      rationale: 'Keep entity note and synthesis separate.',
    });
    expect(adjudicated.adjudication?.reason_code).toBe('intentional-structure');

    const after = runtime.planGarden({ limit: 10 });
    expect(after.opportunities[0]?.kind).toBe('stale-synthesis');
    const duplicate = after.opportunities.find(item => item.id === before.opportunities[0]!.id);
    expect(duplicate?.priority_raw).toBeGreaterThan(duplicate?.priority_effective ?? 0);
    expect(duplicate?.adjudication?.reason_code).toBe('intentional-structure');
    runtime.close();

    runtime = new GraniteMcpRuntime(tmpDir, { indexCheckIntervalMs: 0 });
    const persisted = runtime.planGarden({ limit: 10 });
    const persistedDuplicate = persisted.opportunities.find(item => item.id === before.opportunities[0]!.id);
    expect(persisted.opportunities[0]?.kind).toBe('stale-synthesis');
    expect(persistedDuplicate?.adjudication?.active).toBe(true);
    expect(runtime.listGardenAdjudications()).toHaveLength(1);

    const cleared = runtime.adjudicateGardenOpportunity({
      opportunity_id: before.opportunities[0]!.id,
      decision: 'clear',
    });
    expect(cleared.cleared).toBe(true);
    const restored = runtime.planGarden({ limit: 10 });
    expect(restored.opportunities[0]?.kind).toBe('duplicate-pair');
    runtime.close();
  });

  it('expires already-current and blocked adjudications when their conditions change', () => {
    let runtime = new GraniteMcpRuntime(tmpDir, { indexCheckIntervalMs: 0 });
    const anchor = runtime.createNote({
      title: 'Garden Anchor',
      type: 'note',
      body: 'Anchor note for Granite planning.\n',
      tags: ['granite-vision'],
    });
    const update = runtime.createNote({
      title: 'Granite Update A',
      type: 'note',
      body: 'Fresh note that links [[Garden Anchor]].\n',
      tags: ['granite-vision'],
    });
    const synthesis = runtime.createNote({
      title: 'Garden Synthesis',
      type: 'synthesis',
      body: 'Old synthesis for [[Garden Anchor]].\n',
      tags: ['granite-vision'],
      derived_from: [anchor.note.slug],
    });

    rewriteNoteTimestamps(anchor.note.filepath, { modified: isoDaysAgo(25) });
    rewriteNoteTimestamps(update.note.filepath, { modified: isoDaysAgo(1) });
    rewriteNoteTimestamps(synthesis.note.filepath, { modified: isoDaysAgo(30) });

    const initialPlan = runtime.planGarden({ limit: 10 });
    const stale = initialPlan.opportunities.find(item => item.kind === 'stale-synthesis');
    expect(stale).toBeTruthy();

    runtime.adjudicateGardenOpportunity({
      opportunity_id: stale!.id,
      decision: 'downrank',
      reason_code: 'already-current',
    });
    expect(runtime.listGardenAdjudications()).toHaveLength(1);

    rewriteNoteTimestamps(update.note.filepath, { modified: new Date().toISOString() });
    runtime.close();

    runtime = new GraniteMcpRuntime(tmpDir, { indexCheckIntervalMs: 0 });
    expect(runtime.listGardenAdjudications()).toHaveLength(0);

    const refreshedPlan = runtime.planGarden({ limit: 10 });
    const refreshedStale = refreshedPlan.opportunities.find(item => item.id === stale!.id);
    expect(refreshedStale?.adjudication).toBeUndefined();

    runtime.adjudicateGardenOpportunity({
      opportunity_id: stale!.id,
      decision: 'downrank',
      reason_code: 'blocked',
      recheck_after_days: 1,
    });

    const storePath = getGardenAdjudicationsPath(tmpDir);
    const rawStore = JSON.parse(fs.readFileSync(storePath, 'utf-8')) as {
      version: number;
      entries: Record<string, { updated_at: string }>;
    };
    rawStore.entries[stale!.id].updated_at = isoDaysAgo(2);
    fs.writeFileSync(storePath, `${JSON.stringify(rawStore, null, 2)}\n`, 'utf-8');

    runtime.close();
    runtime = new GraniteMcpRuntime(tmpDir, { indexCheckIntervalMs: 0 });
    expect(runtime.listGardenAdjudications()).toHaveLength(0);
    runtime.close();
  });
});

function rewriteNoteTimestamps(filepath: string, updates: { modified: string }) {
  const raw = fs.readFileSync(filepath, 'utf-8');
  const { frontmatter, body } = parseFrontmatter(raw);
  frontmatter.modified = updates.modified;
  fs.writeFileSync(filepath, serializeFrontmatter(frontmatter, body), 'utf-8');
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString();
}
