import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import { loadConfig } from '../../src/core/config.js';
import { createNote } from '../../src/core/note.js';
import { buildFactLedger, factsFromNotes } from '../../src/core/facts.js';
import {
  auditLogPath,
  factSlug,
  rejectionReason,
  writeFacts,
  type FactProposal,
} from '../../src/core/fact-writer.js';
import { listNotes } from '../../src/core/note.js';
import type { GraniteConfig } from '../../src/core/types.js';

function proposal(overrides: Partial<FactProposal> = {}): FactProposal {
  return {
    source: 'source-note',
    span: 'Monka migre sur Scaleway en juin 2026.',
    subject: 'Monka',
    relation: 'hosting',
    object: 'Scaleway',
    valid_from: '2026-06-01',
    ...overrides,
  };
}

describe('fact writer', () => {
  let tmpDir: string;
  let config: GraniteConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-factwrite-'));
    const cfg: GraniteConfig = {
      vault_name: 't',
      version: 1,
      note_types: {
        note: { folder: 'notes', description: '', template: '', line_limit: 200, warn_only: false },
      },
      defaults: { note_type: 'note', editor: '$EDITOR' },
      index: { auto_rebuild: true },
    };
    fs.writeFileSync(path.join(tmpDir, 'granite.yml'), yaml.dump(cfg));
    fs.mkdirSync(path.join(tmpDir, 'notes'), { recursive: true });
    config = loadConfig(tmpDir);
    createNote(tmpDir, config, 'note', 'Source Note', 'Monka migre sur Scaleway en juin 2026.\n');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('refuses a proposal with no source', () => {
    const result = writeFacts(tmpDir, config, [proposal({ source: '' })], { apply: true });
    expect(result.written).toEqual([]);
    expect(result.rejected[0].reason).toContain('no source');
  });

  it('refuses a proposal with no verbatim span', () => {
    const result = writeFacts(tmpDir, config, [proposal({ span: '' })], { apply: true });
    expect(result.rejected[0].reason).toContain('not traceable');
  });

  it('refuses an object that does not appear in the span', () => {
    // This is the anti-laundering rule: a real-looking quote cannot carry a value
    // that is not in it.
    const result = writeFacts(tmpDir, config, [proposal({ object: 'OVH' })], { apply: true });
    expect(result.written).toEqual([]);
    expect(result.rejected[0].reason).toContain('does not appear in the span');
  });

  it('refuses a non-ISO valid_from', () => {
    const result = writeFacts(tmpDir, config, [proposal({ valid_from: 'juin 2026' })], { apply: true });
    expect(result.rejected[0].reason).toContain('not an ISO date');
  });

  it('plans without writing when apply is false', () => {
    const result = writeFacts(tmpDir, config, [proposal()], { apply: false });
    expect(result.written).toHaveLength(1);
    expect(fs.readdirSync(path.join(tmpDir, 'notes'))).toHaveLength(1); // only the source note
  });

  it('writes a fact note the ledger can read', () => {
    const result = writeFacts(tmpDir, config, [proposal()], { apply: true });
    expect(result.written).toHaveLength(1);

    const notes = listNotes(tmpDir, config);
    const facts = factsFromNotes(notes);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      subject: 'Monka',
      relation: 'hosting',
      object: 'Scaleway',
      valid_from: '2026-06-01',
      source: 'source-note',
    });

    const ledger = buildFactLedger(facts, Date.parse('2026-07-01T00:00:00.000Z'));
    expect(ledger.current).toHaveLength(1);
  });

  it('is idempotent: the same proposal twice writes one note', () => {
    const first = writeFacts(tmpDir, config, [proposal()], { apply: true });
    const second = writeFacts(tmpDir, config, [proposal()], { apply: true });
    expect(first.written).toHaveLength(1);
    expect(second.written).toHaveLength(0);
    expect(second.existing).toEqual(first.written);
  });

  it('keeps the same fact from two different sources as two notes', () => {
    // Two independent pieces of evidence are not one fact.
    const result = writeFacts(
      tmpDir,
      config,
      [proposal(), proposal({ source: 'other-source' })],
      { apply: true },
    );
    expect(new Set(result.written).size).toBe(2);
  });

  it('carries provenance into the note so the claim stays auditable', () => {
    const result = writeFacts(tmpDir, config, [proposal()], { apply: true });
    const file = path.join(tmpDir, 'notes', `${result.written[0]}.md`);
    const content = fs.readFileSync(file, 'utf-8');
    expect(content).toContain('source_note:');
    expect(content).toContain('claim_span:');
    expect(content).toContain('Monka migre sur Scaleway');
    expect(content).toContain('derived_from:');
  });

  it('appends an audit line when it applies', () => {
    writeFacts(tmpDir, config, [proposal()], { apply: true });
    const log = fs.readFileSync(auditLogPath(tmpDir), 'utf-8').trim().split('\n');
    expect(log).toHaveLength(1);
    const event = JSON.parse(log[0]);
    expect(event.action).toBe('facts.write');
    expect(event.inserted).toHaveLength(1);
  });

  it('does not audit a dry run', () => {
    writeFacts(tmpDir, config, [proposal()], { apply: false });
    expect(fs.existsSync(auditLogPath(tmpDir))).toBe(false);
  });

  it('never retires an existing fact', () => {
    // A newer fact wins under the ledger rule; the older note is untouched, which is
    // what keeps the write path additive and reversible.
    writeFacts(tmpDir, config, [proposal()], { apply: true, now: new Date('2026-06-02T00:00:00Z') });
    const newer = proposal({ object: 'OVH', span: 'Monka tourne desormais sur OVH.', valid_from: '2026-08-01' });
    const result = writeFacts(tmpDir, config, [newer], { apply: true, now: new Date('2026-08-02T00:00:00Z') });

    expect(result.written).toHaveLength(1);
    const facts = factsFromNotes(listNotes(tmpDir, config));
    expect(facts).toHaveLength(2); // both notes still exist
    const ledger = buildFactLedger(facts, Date.parse('2026-09-01T00:00:00.000Z'));
    expect(ledger.current.map(f => f.object)).toEqual(['OVH']);
    expect(ledger.entries.filter(e => e.status === 'superseded').map(e => e.fact.object)).toEqual(['Scaleway']);
  });

  it('derives a stable slug from the fact identity and its source', () => {
    const a = factSlug(proposal());
    const b = factSlug(proposal({ span: 'a different wording of the same claim' }));
    expect(a).toBe(b);
    expect(a).toContain('monka');
    expect(a).toContain('scaleway');
    expect(a).toContain('source-note');
    expect(factSlug(proposal({ source: 'elsewhere' }))).not.toBe(a);
  });

  it('reports a rejection reason directly', () => {
    expect(rejectionReason(proposal())).toBeUndefined();
    expect(rejectionReason(proposal({ relation: '' }))).toContain('no relation');
  });
});
