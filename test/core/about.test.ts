import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { aboutEntity, candidateSentences, entityPool } from '../../src/core/about.js';

/**
 * Minimal stand-in for the index: `aboutEntity` is a read of the graph, so the test
 * builds the two tables it touches rather than a whole vault.
 */
function db(): Database.Database {
  const d = new Database(':memory:');
  d.exec(`
    CREATE TABLE notes (slug TEXT PRIMARY KEY, title TEXT, type TEXT, status TEXT, body TEXT);
    CREATE TABLE links (source_slug TEXT, target_slug TEXT, target_raw TEXT, context TEXT);
  `);
  const note = d.prepare('INSERT INTO notes VALUES (?,?,?,?,?)');
  note.run('monka-care', 'Monka.care', 'organization', 'active',
    'Monka.care est une plateforme de santé qui opère en France depuis 2025.');
  note.run('meeting-a', 'Kickoff with Monka', 'meeting', 'active',
    'Kickoff meeting for the Monka engagement covering scope and milestones.');
  note.run('person-a', 'Étienne Rubi', 'person', 'active',
    'Étienne Rubi est cofondateur de Monka.care et sponsor exécutif du projet.');
  note.run('synthesis-a', 'HDS synthesis', 'synthesis', 'active',
    'Synthesis of the hosting compliance work for the Monka platform.');
  const link = d.prepare('INSERT INTO links VALUES (?,?,?,?)');
  link.run('meeting-a', 'monka-care', 'Monka.care', 'Kickoff with [[Monka.care]]');
  link.run('person-a', 'monka-care', 'Monka.care', 'cofounder of [[Monka.care]]');
  link.run('synthesis-a', 'monka-care', 'Monka.care', 'HDS context for [[Monka.care]]');
  link.run('monka-care', 'person-a', 'Étienne Rubi', 'sponsor is [[Étienne Rubi]]');
  return d;
}

describe('aboutEntity', () => {
  it('groups incoming references by the type of the referring note', () => {
    const d = db();
    const result = aboutEntity(d, 'monka-care')!;
    expect(Object.keys(result.incoming).sort()).toEqual(['meeting', 'person', 'synthesis']);
    expect(result.counts.incoming).toBe(3);
    d.close();
  });

  it('carries the context that explains why the note points here', () => {
    const d = db();
    const result = aboutEntity(d, 'monka-care')!;
    expect(result.incoming.meeting[0].contexts[0]).toContain('Kickoff');
    d.close();
  });

  it('collapses repeated references to one note into a single entry', () => {
    // A note that names the entity three times is still one note; counting it three
    // times inflates the view and buries the other referrers.
    const d = db();
    const link = d.prepare('INSERT INTO links VALUES (?,?,?,?)');
    link.run('meeting-a', 'monka-care', 'Monka.care', 'second mention of [[Monka.care]]');
    link.run('meeting-a', 'monka-care', 'Monka.care', 'third mention of [[Monka.care]]');
    const result = aboutEntity(d, 'monka-care')!;
    expect(result.incoming.meeting).toHaveLength(1);
    expect(result.incoming.meeting[0].contexts.length).toBeLessThanOrEqual(3);
    expect(result.counts.incoming).toBe(3);
    d.close();
  });

  it('separates what links here from what this links to', () => {
    const d = db();
    const result = aboutEntity(d, 'monka-care')!;
    expect(result.counts.incoming).toBe(3);
    expect(result.counts.outgoing).toBe(1);
    expect(result.outgoing.person[0].slug).toBe('person-a');
    d.close();
  });

  it('drops dangling targets rather than inventing a note', () => {
    const d = db();
    d.prepare('INSERT INTO links VALUES (?,?,?,?)').run('monka-care', 'not-a-note', 'not-a-note', 'x');
    const result = aboutEntity(d, 'monka-care')!;
    expect(result.counts.outgoing).toBe(1);
    d.close();
  });

  it('returns undefined for a slug the vault does not have', () => {
    const d = db();
    expect(aboutEntity(d, 'nope')).toBeUndefined();
    d.close();
  });

  it('distinguishes a note nothing leads to', () => {
    // Absence is information: no other note leads here.
    const d = db();
    const result = aboutEntity(d, 'synthesis-a')!;
    expect(result.counts.incoming).toBe(0);
    expect(result.counts.outgoing).toBe(1);
    d.close();
  });
});

describe('entityPool', () => {
  it('orders candidates by graph distance, nearest first', () => {
    // Distance is the only ordering signal. A lexical pre-rank was tried and it dropped
    // the note holding the answer because the question was in another language.
    const d = db();
    const result = entityPool(d, 'monka-care', { limit: 10 })!;
    expect(result.candidates[0].distance).toBe(1);
    const distances = result.candidates.map(c => c.distance);
    expect([...distances].sort((a, b) => a - b)).toEqual(distances);
    d.close();
  });

  it('reports how many notes were reachable before the limit', () => {
    const d = db();
    const result = entityPool(d, 'monka-care', { limit: 1 })!;
    expect(result.reachable).toBeGreaterThan(result.candidates.length);
    expect(result.candidates).toHaveLength(1);
    d.close();
  });

  it('walks the requested depth and excludes the anchor from its own pool', () => {
    const d = db();
    const oneHop = entityPool(d, 'monka-care', { depth: 1, limit: 50 })!;
    expect(oneHop.candidates.every(c => c.distance === 1)).toBe(true);
    expect(oneHop.candidates.map(c => c.slug)).not.toContain('monka-care');
    d.close();
  });

  it('can return titles only when sentences are not wanted', () => {
    const d = db();
    const result = entityPool(d, 'monka-care', { sentences: 0 })!;
    // An empty array, not null: this goes out as JSON and is read by consumers in other
    // languages, where a null turns into a branch (or a crash) instead of an empty list.
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates.every(c => Array.isArray(c.sentences))).toBe(true);
    expect(result.candidates.every(c => c.sentences.length === 0)).toBe(true);
    d.close();
  });

  it('returns undefined for an anchor the vault does not have', () => {
    const d = db();
    expect(entityPool(d, 'nope')).toBeUndefined();
    d.close();
  });
});

describe('candidateSentences', () => {
  it('does not strip frontmatter, because it never receives any', () => {
    // `body` is gray-matter output, so frontmatter is already gone upstream. An earlier
    // version carried a frontmatter strip here as a defensive measure; the pattern was
    // dead code (``\A`` is not a JS anchor), and the obvious "fix" made it destructive:
    // a legitimate body beginning with a horizontal rule and containing a later `---`
    // lost everything between them. The right defence is to not have it.
    const body = [
      '---',
      'This paragraph sits between two horizontal rules and is real note content,',
      'not frontmatter, so it must survive into the candidate sentences intact.',
      '---',
      'Monka migre son infrastructure vers Scaleway en juin 2026 pour la conformité HDS.',
    ].join('\n');
    const out = candidateSentences(body, 6);
    expect(out.join(' ')).toContain('real note content');
    expect(out.join(' ')).toContain('Scaleway');
  });

  it('drops code fences and headings', () => {
    const body = [
      '## Summary',
      '```js', 'const notASentence = true;', '```',
      'Monka migre son infrastructure vers Scaleway en juin 2026 pour la conformité HDS.',
    ].join('\n');
    const out = candidateSentences(body, 6);
    expect(out.join(' ')).not.toContain('notASentence');
    expect(out).toHaveLength(1);
  });

  it('respects the limit and drops fragments too short to carry meaning', () => {
    const body = 'Ok.\n' + 'Cette phrase est suffisamment longue pour être un candidat sérieux.\n'.repeat(20);
    const out = candidateSentences(body, 3);
    expect(out).toHaveLength(3);
  });

  it('returns nothing when asked for nothing', () => {
    // `0` is the documented "titles only" mode. The loop pushes before it can test the
    // bound, so without an explicit guard `limit: 0` handed back one sentence anyway.
    const body = 'Cette phrase est suffisamment longue pour être un candidat sérieux.';
    expect(candidateSentences(body, 0)).toEqual([]);
    expect(candidateSentences(body, -1)).toEqual([]);
  });
});

describe('pool ordering and bounds', () => {
  it('includes a distance-2 note so the depth walk is actually exercised', () => {
    // The fixture previously contained no second-hop note, so a broken depth walk was
    // invisible. far-a is only reachable through person-a.
    const d = db();
    d.prepare('INSERT INTO notes VALUES (?,?,?,?,?)').run(
      'far-a', 'Second hop note', 'note', 'active',
      'This note is two hops from the anchor and must appear at distance 2.');
    d.prepare('INSERT INTO links VALUES (?,?,?,?)').run('person-a', 'far-a', 'far-a', 'x');
    const pool = entityPool(d, 'monka-care', { depth: 2, limit: 50 })!;
    const far = pool.candidates.find(c => c.slug === 'far-a');
    expect(far?.distance).toBe(2);
    d.close();
  });

  it('excludes a distance-2 note when depth is 1', () => {
    const d = db();
    d.prepare('INSERT INTO notes VALUES (?,?,?,?,?)').run(
      'far-a', 'Second hop note', 'note', 'active',
      'This note is two hops from the anchor and must not appear at depth 1.');
    d.prepare('INSERT INTO links VALUES (?,?,?,?)').run('person-a', 'far-a', 'far-a', 'x');
    const pool = entityPool(d, 'monka-care', { depth: 1, limit: 50 })!;
    expect(pool.candidates.map(c => c.slug)).not.toContain('far-a');
    d.close();
  });

  it('terminates on a cycle instead of looping', () => {
    const d = db();
    d.prepare('INSERT INTO links VALUES (?,?,?,?)').run('person-a', 'meeting-a', 'meeting-a', 'cycle');
    d.prepare('INSERT INTO links VALUES (?,?,?,?)').run('meeting-a', 'person-a', 'person-a', 'cycle');
    const pool = entityPool(d, 'monka-care', { depth: 5, limit: 50 })!;
    expect(pool.candidates.every(c => c.distance <= 5)).toBe(true);
    d.close();
  });
});

// The `about` flag combinations are covered against the real `aboutCommand` in
// `test/commands/about.test.ts`. A local `select()` helper used to live here and
// re-implemented the guards, which only proved that a copy of the logic worked.
