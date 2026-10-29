import { describe, expect, it } from 'vitest';
import {
  bodyHasSection,
  computeTypeRegistrySignature,
  deriveBodySections,
  getRequiredSections,
  renderPreflightError,
  validateNoteAgainstType,
} from '../../src/core/validate.js';
import type { GraniteConfig, NoteFrontmatter } from '../../src/core/types.js';

function baseFrontmatter(overrides: Partial<NoteFrontmatter> = {}): NoteFrontmatter {
  return {
    id: 'id',
    title: 'T',
    type: 'meeting',
    created: '2026-04-17T00:00:00Z',
    modified: '2026-04-17T00:00:00Z',
    tags: [],
    aliases: [],
    status: 'active',
    source: 'agent',
    review_state: 'draft',
    durability: 'canonical',
    derived_from: [],
    ...overrides,
  };
}

function configWith(meetingWarnOnly: boolean): GraniteConfig {
  return {
    vault_name: 'V',
    version: 1,
    note_types: {
      note: {
        folder: 'notes',
        description: 'd',
        template: '## Summary\n\n## Details\n',
        line_limit: 200,
        warn_only: true,
      },
      meeting: {
        folder: 'meetings',
        description: 'd',
        template: '## Summary\n\n## Decisions\n\n## Action items\n',
        line_limit: 300,
        warn_only: meetingWarnOnly,
        fields: {
          date: { type: 'date', required: true, description: 'date' },
          attendees: { type: 'list', of: 'wikilink', description: 'a' },
        },
      },
    },
    defaults: { note_type: 'note', editor: '' },
    index: { auto_rebuild: true },
  };
}

describe('deriveBodySections', () => {
  it('extracts H2 headings from a template', () => {
    expect(deriveBodySections('## Summary\n\n## Decisions\n\ntext\n## Links\n'))
      .toEqual(['Summary', 'Decisions', 'Links']);
  });

  it('returns an empty array for templates without H2 headings', () => {
    expect(deriveBodySections('Just prose\n')).toEqual([]);
  });
});

describe('getRequiredSections', () => {
  it('prefers explicit body_sections over template-derived sections', () => {
    const result = getRequiredSections({
      folder: 'x',
      description: '',
      template: '## A\n## B\n',
      line_limit: 100,
      warn_only: true,
      body_sections: ['Foo', 'Bar'],
    });
    expect(result).toEqual(['Foo', 'Bar']);
  });
});

describe('bodyHasSection', () => {
  it('matches case-insensitively and trims whitespace', () => {
    const body = '## Summary\nhi\n## action Items \n';
    expect(bodyHasSection(body, 'summary')).toBe(true);
    expect(bodyHasSection(body, 'Action Items')).toBe(true);
    expect(bodyHasSection(body, 'Missing')).toBe(false);
  });
});

describe('validateNoteAgainstType', () => {
  it('returns unknown_type error when the type is not in the registry', () => {
    const config = configWith(false);
    const fm = baseFrontmatter({ type: 'retro' });
    const r = validateNoteAgainstType('retro', fm, '', config);
    expect(r.passed).toBe(false);
    expect(r.errors[0].code).toBe('unknown_type');
  });

  it('flags missing required fields as errors when warn_only=false', () => {
    const config = configWith(false);
    const fm = baseFrontmatter({ type: 'meeting' });
    const r = validateNoteAgainstType('meeting', fm, '## Summary\n## Decisions\n## Action items\n', config);
    expect(r.passed).toBe(false);
    expect(r.errors.map(e => e.code)).toContain('missing_required_field');
    expect(r.errors.find(e => e.code === 'missing_required_field')?.field).toBe('date');
  });

  it('downgrades missing required fields to warnings when warn_only=true', () => {
    const config = configWith(true);
    const fm = baseFrontmatter({ type: 'meeting' });
    const r = validateNoteAgainstType('meeting', fm, '## Summary\n## Decisions\n## Action items\n', config);
    expect(r.passed).toBe(true);
    expect(r.warnings.map(w => w.code)).toContain('missing_required_field');
  });

  it('warns on missing body sections but does not error', () => {
    const config = configWith(true);
    const fm = baseFrontmatter({ type: 'meeting', date: '2026-04-17' } as never);
    const r = validateNoteAgainstType('meeting', fm, '## Summary\nonly a summary, no decisions\n', config);
    expect(r.warnings.map(w => w.code)).toContain('missing_sections');
  });

  it('passes cleanly when all required fields and sections are present', () => {
    const config = configWith(false);
    const fm = baseFrontmatter({ type: 'meeting', date: '2026-04-17' } as never);
    const r = validateNoteAgainstType('meeting', fm, '## Summary\n## Decisions\n## Action items\n', config);
    expect(r.passed).toBe(true);
    expect(r.errors).toHaveLength(0);
  });
});

describe('computeTypeRegistrySignature', () => {
  it('changes when a required field is added', () => {
    const a = configWith(false);
    const b = configWith(false);
    b.note_types.meeting.fields!.location = { type: 'text', required: true };
    expect(computeTypeRegistrySignature(a)).not.toBe(computeTypeRegistrySignature(b));
  });

  it('changes when indexed_fields changes', () => {
    const config = configWith(false);
    const before = computeTypeRegistrySignature(config);
    config.note_types.meeting.indexed_fields = ['date'];
    expect(computeTypeRegistrySignature(config)).not.toBe(before);
  });

  it('is stable for semantically identical configs', () => {
    expect(computeTypeRegistrySignature(configWith(false))).toBe(computeTypeRegistrySignature(configWith(false)));
  });
});

describe('renderPreflightError', () => {
  it('formats all errors with codes and messages', () => {
    const msg = renderPreflightError('meeting', [
      { code: 'missing_required_field', field: 'date', message: 'date required' },
    ]);
    expect(msg).toContain('meeting');
    expect(msg).toContain('missing_required_field');
    expect(msg).toContain('date required');
  });
});
