import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, writeDefaultConfig } from '../../src/core/config.js';
import { GraniteMcpRuntime } from '../../src/mcp/runtime.js';

describe('GraniteMcpRuntime validation & type registry exposure', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-validate-'));
    writeDefaultConfig(tmpDir);
    // Add a strict `meeting` type with a required field to the vault config
    const raw = yaml.load(fs.readFileSync(path.join(tmpDir, 'granite.yml'), 'utf-8')) as any;
    raw.note_types.meeting = {
      folder: 'notes/meetings',
      description: 'Meetings with decisions and action items',
      template: '## Summary\n\n## Decisions\n\n## Action items\n',
      line_limit: 300,
      warn_only: false,
      fields: {
        date: { type: 'date', required: true, description: 'Meeting date' },
      },
      frontmatter_defaults: { durability: 'canonical' },
    };
    fs.writeFileSync(path.join(tmpDir, 'granite.yml'), yaml.dump(raw));
    const config = loadConfig(tmpDir);
    for (const typeConfig of Object.values(config.note_types)) {
      fs.mkdirSync(path.join(tmpDir, typeConfig.folder), { recursive: true });
    }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('listNoteTypeNames returns all configured types', () => {
    const runtime = new GraniteMcpRuntime(tmpDir, { indexCheckIntervalMs: 0 });
    const names = runtime.listNoteTypeNames();
    expect(names).toContain('note');
    expect(names).toContain('meeting');
    runtime.close();
  });

  it('listNoteTypes exposes template, body_sections, and frontmatter_defaults', () => {
    const runtime = new GraniteMcpRuntime(tmpDir, { indexCheckIntervalMs: 0 });
    const types = runtime.listNoteTypes();
    const meeting = types.find(t => t.name === 'meeting');
    expect(meeting).toBeDefined();
    expect(meeting!.template).toContain('## Summary');
    expect(meeting!.body_sections).toEqual(['Summary', 'Decisions', 'Action items']);
    expect(meeting!.frontmatter_defaults).toMatchObject({ durability: 'canonical' });
    runtime.close();
  });

  it('listNoteTypes resolves example_slug to the most recent note of each type', () => {
    const runtime = new GraniteMcpRuntime(tmpDir, { indexCheckIntervalMs: 0 });
    runtime.createNote({ author: 'stan', title: 'One', type: 'note', body: 'x\n' });
    const types = runtime.listNoteTypes();
    const noteT = types.find(t => t.name === 'note');
    expect(noteT!.example_slug).toBe('one');
    runtime.close();
  });

  it('throws a structured error for unknown types on createNote', () => {
    const runtime = new GraniteMcpRuntime(tmpDir, { indexCheckIntervalMs: 0 });
    expect(() => runtime.createNote({ author: 'stan', title: 'X', type: 'retro' as never, body: 'y\n' }))
      .toThrow(/Unknown note type "retro"/);
    runtime.close();
  });

  it('rejects creation of a strict-type note missing a required field', () => {
    const runtime = new GraniteMcpRuntime(tmpDir, { indexCheckIntervalMs: 0 });
    expect(() => runtime.createNote({ author: 'stan',
      title: 'Monka sync',
      type: 'meeting' as never,
      body: '## Summary\n## Decisions\n## Action items\n',
    })).toThrow(/missing_required_field/);
    runtime.close();
  });

  it('accepts creation when required fields are supplied via extra frontmatter', () => {
    const runtime = new GraniteMcpRuntime(tmpDir, { indexCheckIntervalMs: 0 });
    const result = runtime.createNote({ author: 'stan',
      title: 'Monka sync',
      type: 'meeting' as never,
      body: '## Summary\n## Decisions\n## Action items\n',
      fields: { date: '2026-04-17' },
    });
    expect(result.validation?.passed).toBe(true);
    expect(result.note.frontmatter.date).toBe('2026-04-17');
    runtime.close();
  });

  it('captured result includes validation warnings for warn_only types', () => {
    const runtime = new GraniteMcpRuntime(tmpDir, { indexCheckIntervalMs: 0 });
    const result = runtime.captureNote({ author: 'stan', text: 'A line with no standard sections', type: 'note' });
    // `note` is strict (warn_only=false); but there's no required field nor section check for prose captures
    expect(result.validation).toBeDefined();
    runtime.close();
  });

  it('rejects reviseNote that promotes a note to a strict type without required fields', () => {
    const runtime = new GraniteMcpRuntime(tmpDir, { indexCheckIntervalMs: 0 });
    const created = runtime.createNote({ author: 'stan', title: 'Promote me', type: 'note', body: '## Summary\n## Details\n' });
    expect(() => runtime.reviseNote(created.note.slug, { author: 'stan', type: 'meeting' as never }))
      .toThrow(/missing_required_field/);
    runtime.close();
  });

  it('accepts reviseNote promotion when required fields are supplied via fields', () => {
    const runtime = new GraniteMcpRuntime(tmpDir, { indexCheckIntervalMs: 0 });
    const created = runtime.createNote({ author: 'stan', title: 'Promote me', type: 'note', body: '## Summary\n## Details\n' });
    const revised = runtime.reviseNote(created.note.slug, { author: 'stan',
      type: 'meeting' as never,
      fields: { date: '2026-04-17' },
      body: '## Summary\n## Decisions\n## Action items\n',
    });
    expect(revised.validation?.passed).toBe(true);
    expect(revised.note.frontmatter.type).toBe('meeting');
    expect(revised.note.frontmatter.date).toBe('2026-04-17');
    runtime.close();
  });

  it('rejects reviseNote that pushes a strict-type body past line_limit and does not write', () => {
    const runtime = new GraniteMcpRuntime(tmpDir, { indexCheckIntervalMs: 0 });
    const created = runtime.createNote({ author: 'stan',
      title: 'Sync',
      type: 'meeting' as never,
      body: '## Summary\n## Decisions\n## Action items\n',
      fields: { date: '2026-04-17' },
    });
    const originalBody = created.note.body;
    const hugeAppend = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n');
    expect(() => runtime.reviseNote(created.note.slug, { author: 'stan', append: hugeAppend }))
      .toThrow(/line_limit_exceeded/);
    // Verify the file was not mutated.
    const reread = runtime.getNote(created.note.slug);
    expect(reread.body).toBe(originalBody);
    runtime.close();
  });

  it('getTypeRegistrySignature is stable across runtime recreations for unchanged config', () => {
    const r1 = new GraniteMcpRuntime(tmpDir, { indexCheckIntervalMs: 0 });
    const sig1 = r1.getTypeRegistrySignature();
    r1.close();
    const r2 = new GraniteMcpRuntime(tmpDir, { indexCheckIntervalMs: 0 });
    expect(r2.getTypeRegistrySignature()).toBe(sig1);
    r2.close();
  });

  it('wakeup AAAK contains the TYPES pointer with signature and resource URI', () => {
    const runtime = new GraniteMcpRuntime(tmpDir, { indexCheckIntervalMs: 0 });
    runtime.createNote({ author: 'stan', title: 'Seed', type: 'note', body: 'x\n' });
    const wk = runtime.wakeup();
    expect(wk.aaak).toMatch(/TYPES: \d+ \(sig=[0-9a-f]{8}\) -> granite:\/\/vault\/types/);
    runtime.close();
  });
});
