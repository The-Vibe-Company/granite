import { describe, expect, it } from 'vitest';
import {
  findAlignmentCandidates,
  normalizeName,
  planAlignment,
  type EntityNote,
} from '../../src/core/entities.js';

function note(slug: string, title: string, type = 'organization', aliases: string[] = []): EntityNote {
  return { slug, title, type, aliases };
}

describe('entity alignment', () => {
  it('folds case, accents, punctuation and spacing', () => {
    expect(normalizeName('Agence France-Presse (AFP)')).toBe('agence france presse afp');
    expect(normalizeName('  monka.care  ')).toBe('monka care');
    expect(normalizeName('Étienne Rubi')).toBe('etienne rubi');
  });

  it('finds notes with identical normalised titles', () => {
    const candidates = findAlignmentCandidates([
      note('a', 'Kima Ventures (Alexis Robert)'),
      note('b', 'kima  ventures — alexis robert'),
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].reason).toBe('same-normalised-title');
    expect(candidates[0].cross_type).toBe(false);
  });

  it('finds an alias claimed by two notes', () => {
    const candidates = findAlignmentCandidates([
      note('a', 'Datacurve Benchmark', 'source', ['deepswe-benchmark']),
      note('b', 'DeepSWE', 'note', ['deepswe-benchmark']),
    ]);
    const shared = candidates.filter(c => c.reason === 'shared-alias');
    expect(shared).toHaveLength(1);
    expect(shared[0].matched_on).toBe('deepswe benchmark');
    expect(shared[0].cross_type).toBe(true);
  });

  it('emits one entry per pair and never pairs a note with itself', () => {
    const candidates = findAlignmentCandidates([
      note('a', 'Same', 'note', ['same alias']),
      note('b', 'Same', 'note', ['same alias']),
    ]);
    const pairs = candidates.map(c => [c.a.slug, c.b.slug].sort().join('|'));
    expect(new Set(pairs).size).toBe(pairs.length);
    expect(pairs).not.toContain('a|a');
  });

  it('is stable regardless of input order', () => {
    const notes = [
      note('a', 'Same Name'),
      note('b', 'same name'),
      note('c', 'Other', 'note', ['shared']),
      note('d', 'Another', 'note', ['shared']),
    ];
    const forward = findAlignmentCandidates(notes);
    const reversed = findAlignmentCandidates([...notes].reverse());
    const key = (c: { a: EntityNote; b: EntityNote }) => [c.a.slug, c.b.slug].sort().join('|');
    expect(forward.map(key)).toEqual(reversed.map(key));
  });

  it('plans an alias edge for a same-type shared alias', () => {
    const plan = planAlignment(
      findAlignmentCandidates([
        note('short', 'Kima'),
        note('long', 'Kima Ventures', 'organization', ['kima']),
      ]),
    );
    expect(plan.aliases).toHaveLength(1);
    expect(plan.aliases[0].target).toBe('short');
    expect(plan.aliases[0].alias).toBe('Kima Ventures');
    expect(plan.review).toHaveLength(0);
  });

  it('sends a cross-type match to review instead of planning a fold', () => {
    const plan = planAlignment(
      findAlignmentCandidates([
        note('person-afp', 'Agence France-Presse (AFP)', 'person'),
        note('org-afp', 'Agence France-Presse (AFP)', 'organization'),
      ]),
    );
    expect(plan.aliases).toHaveLength(0);
    expect(plan.review).toHaveLength(1);
    expect(plan.review[0].why).toContain('different types');
  });

  it('sends identical same-type titles to review, because bodies should be merged', () => {
    const plan = planAlignment(
      findAlignmentCandidates([
        note('a', 'Kima Ventures (Alexis Robert)', 'note'),
        note('b', 'Kima Ventures (Alexis Robert)', 'note'),
      ]),
    );
    expect(plan.aliases).toHaveLength(0);
    expect(plan.review[0].why).toContain('merge the bodies');
  });

  it('sends a contested third alias to review instead of folding one title into the other', () => {
    // Regression: two distinct people each listed "PLB". The shared alias is neither
    // note's title, so it proves nothing about equivalence. Folding used to alias one
    // person's full name onto the other.
    const plan = planAlignment(
      findAlignmentCandidates([
        note('plb-person', 'Pierre-Louis Biojout (PLB)', 'person', ['plb']),
        note('pliny', 'Pliny the Liberator (@elder_plinius)', 'person', ['PLB']),
      ]),
    );
    expect(plan.aliases).toHaveLength(0);
    expect(plan.review).toHaveLength(1);
    expect(plan.review[0].why).toContain('contested');
  });

  it('makes the note whose title is the shared name canonical, not the shortest title', () => {
    const plan = planAlignment(
      findAlignmentCandidates([
        note('long-owner', 'Kima Ventures (Alexis Robert)'),
        note('short-claimer', 'Kima', 'organization', ['Kima Ventures (Alexis Robert)']),
      ]),
    );
    expect(plan.aliases).toHaveLength(1);
    expect(plan.aliases[0].target).toBe('long-owner');
    expect(plan.aliases[0].alias).toBe('Kima');
  });

  it('never plans an action that would rewrite a note', () => {
    // The plan is only alias attachments and review items: there is no mutation of
    // an existing note anywhere, which is what keeps this reversible.
    const plan = planAlignment(
      findAlignmentCandidates([
        note('a', 'Alpha', 'note', ['shared']),
        note('b', 'Beta', 'note', ['shared']),
      ]),
    );
    expect(Object.keys(plan).sort()).toEqual(['aliases', 'review']);
    for (const entry of plan.aliases) {
      expect(Object.keys(entry).sort()).toEqual(['alias', 'from', 'target']);
    }
  });
});
