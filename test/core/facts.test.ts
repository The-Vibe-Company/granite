import { describe, expect, it } from 'vitest';
import {
  buildFactLedger,
  compareRecency,
  currentStateOf,
  isOpenAt,
  normalizeKey,
  type Fact,
} from '../../src/core/facts.js';

function fact(overrides: Partial<Fact> & Pick<Fact, 'slug' | 'subject' | 'relation' | 'object' | 'valid_from'>): Fact {
  return { title: overrides.slug, ...overrides };
}

const OLD = '2026-01-01T00:00:00.000Z';
const NOW_ISO = '2026-06-01T00:00:00.000Z';
const NEW = '2026-06-01T00:00:00.000Z';
const NOW = Date.parse('2026-07-01T00:00:00.000Z');

describe('fact ledger', () => {
  it('keeps the newer open fact and retires the older one', () => {
    const ledger = buildFactLedger(
      [
        fact({ slug: 'hds-old', subject: 'Monka', relation: 'hosting', object: 'OVH', valid_from: OLD }),
        fact({ slug: 'hds-new', subject: 'Monka', relation: 'hosting', object: 'Scaleway', valid_from: NEW }),
      ],
      NOW,
    );

    expect(currentStateOf(ledger, 'Monka', 'hosting').map(f => f.object)).toEqual(['Scaleway']);
    const retired = ledger.entries.find(e => e.fact.slug === 'hds-old');
    expect(retired?.status).toBe('superseded');
    expect(retired?.superseded_by).toBe('hds-new');
  });

  it('never serves a superseded value', () => {
    const ledger = buildFactLedger(
      [
        fact({ slug: 'a', subject: 'AFP', relation: 'contract', object: 'lot-3', valid_from: OLD }),
        fact({ slug: 'b', subject: 'AFP', relation: 'contract', object: 'lot-4', valid_from: NEW }),
      ],
      NOW,
    );
    const state = currentStateOf(ledger, 'AFP', 'contract');
    expect(state).toHaveLength(1);
    expect(state[0].object).toBe('lot-4');
    expect(state.map(f => f.object)).not.toContain('lot-3');
  });

  it('leaves a closed interval alone when it has not expired', () => {
    // An explicitly closed fact is not displaced by recency: it was ended on purpose
    // and still describes a period that matters.
    const ledger = buildFactLedger(
      [
        fact({ slug: 'term', subject: 'X', relation: 'status', object: 'paused', valid_from: OLD, valid_to: '2026-08-01T00:00:00.000Z' }),
        fact({ slug: 'now', subject: 'X', relation: 'status', object: 'active', valid_from: NEW }),
      ],
      NOW,
    );
    expect(ledger.entries.find(e => e.fact.slug === 'term')?.status).toBe('current');
  });

  it('marks a past valid_to as expired', () => {
    const ledger = buildFactLedger(
      [fact({ slug: 'gone', subject: 'X', relation: 'r', object: 'o', valid_from: OLD, valid_to: '2026-02-01T00:00:00.000Z' })],
      NOW,
    );
    expect(ledger.entries[0].status).toBe('expired');
  });

  it('marks a future valid_from as future and not current', () => {
    const ledger = buildFactLedger(
      [fact({ slug: 'soon', subject: 'X', relation: 'r', object: 'o', valid_from: '2026-12-01T00:00:00.000Z' })],
      NOW,
    );
    expect(ledger.entries[0].status).toBe('future');
    expect(ledger.current).toHaveLength(0);
  });

  it('surfaces contradictions instead of resolving them', () => {
    // The whole point: two open facts that disagree are reported, never silently
    // collapsed, because an automatic choice is how true facts get lost.
    const ledger = buildFactLedger(
      [
        fact({ slug: 'p1', subject: 'Coup de Pates', relation: 'budget', object: '40k', valid_from: OLD }),
        fact({ slug: 'p2', subject: 'Coup de Pates', relation: 'budget', object: '55k', valid_from: NEW }),
      ],
      NOW,
    );

    expect(ledger.contradictions).toHaveLength(1);
    const contradiction = ledger.contradictions[0];
    expect(contradiction.subject).toBe('Coup de Pates');
    expect(contradiction.relation).toBe('budget');
    expect(contradiction.facts.map(f => f.object).sort()).toEqual(['40k', '55k']);
    expect(contradiction.detail).toContain('Not resolved automatically');
  });

  it('does not report a contradiction when open facts agree', () => {
    const ledger = buildFactLedger(
      [
        fact({ slug: 's1', subject: 'TVC', relation: 'founder', object: 'Stan', valid_from: OLD }),
        fact({ slug: 's2', subject: 'TVC', relation: 'founder', object: 'Stan', valid_from: NEW }),
      ],
      NOW,
    );
    expect(ledger.contradictions).toHaveLength(0);
  });

  it('ignores trailing case and whitespace when grouping', () => {
    expect(normalizeKey('  Monka.Care ')).toBe('monka.care');
    const ledger = buildFactLedger(
      [
        fact({ slug: 'x', subject: 'Monka', relation: 'hosting', object: 'OVH', valid_from: OLD }),
        fact({ slug: 'y', subject: 'monka ', relation: ' HOSTING', object: 'Scaleway', valid_from: NEW }),
      ],
      NOW,
    );
    expect(ledger.current).toHaveLength(1);
    expect(ledger.current[0].object).toBe('Scaleway');
  });

  it('produces a stable result regardless of input order', () => {
    const facts = [
      fact({ slug: 'b', subject: 'S', relation: 'r', object: 'two', valid_from: NEW }),
      fact({ slug: 'a', subject: 'S', relation: 'r', object: 'one', valid_from: OLD }),
      fact({ slug: 'c', subject: 'S', relation: 'r', object: 'three', valid_from: OLD }),
    ];
    const forward = buildFactLedger(facts, NOW);
    const reversed = buildFactLedger([...facts].reverse(), NOW);
    expect(forward.current.map(f => f.slug)).toEqual(reversed.current.map(f => f.slug));
    expect(forward.entries.map(e => `${e.fact.slug}:${e.status}`)).toEqual(
      reversed.entries.map(e => `${e.fact.slug}:${e.status}`),
    );
  });

  it('breaks a tie on confidence, then on slug', () => {
    const weak = fact({ slug: 'z', subject: 'S', relation: 'r', object: 'lo', valid_from: NOW_ISO, confidence: 0.4 });
    const strong = fact({ slug: 'a', subject: 'S', relation: 'r', object: 'hi', valid_from: NOW_ISO, confidence: 0.9 });
    expect(compareRecency(strong, weak)).toBeLessThan(0);

    const first = fact({ slug: 'aaa', subject: 'S', relation: 'r', object: 'x', valid_from: NOW_ISO });
    const second = fact({ slug: 'bbb', subject: 'S', relation: 'r', object: 'y', valid_from: NOW_ISO });
    expect(compareRecency(first, second)).toBeLessThan(0);
  });

  it('isOpenAt respects both ends of the interval', () => {
    const f = fact({ slug: 'f', subject: 'S', relation: 'r', object: 'o', valid_from: OLD, valid_to: NEW });
    expect(isOpenAt(f, Date.parse('2026-03-01T00:00:00.000Z'))).toBe(true);
    expect(isOpenAt(f, Date.parse('2026-08-01T00:00:00.000Z'))).toBe(false);
    expect(isOpenAt(f, Date.parse('2025-01-01T00:00:00.000Z'))).toBe(false);
  });
});

