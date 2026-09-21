import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  aboutEntity,
  candidateSentences,
  entityPool,
  filterAbout,
  renderAboutMarkdown,
  renderPoolMarkdown,
} from '../../src/core/about.js';

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

describe('filterAbout and the shared markdown renderers', () => {
  // These two functions are what the MCP tools return, so they are the contract an agent
  // reads. They live in core rather than in the transport so both surfaces share one
  // implementation of the filtering — duplicating it is how the counts drifted from the
  // groups they described in the first place.

  it('keeps every group when no types are requested', () => {
    const d = db();
    const entity = filterAbout(aboutEntity(d, 'monka-care')!);
    expect(Object.keys(entity.incoming).sort()).toEqual(['meeting', 'person', 'synthesis']);
    expect(entity.counts).toEqual({ incoming: 3, outgoing: 1 });
    expect(entity.filtered_by).toBeUndefined();
    d.close();
  });

  it('recomputes the counts from the filtered groups', () => {
    const d = db();
    const entity = filterAbout(aboutEntity(d, 'monka-care')!, ['meeting']);
    expect(Object.keys(entity.incoming)).toEqual(['meeting']);
    expect(entity.counts.incoming).toBe(1);
    // The unfiltered total is kept, because "nothing of the type you asked for" is not
    // "nothing points at this note".
    expect(entity.unfiltered_counts).toEqual({ incoming: 3, outgoing: 1 });
    d.close();
  });

  it('renders the groups with their type and the context of each reference', () => {
    const d = db();
    const markdown = renderAboutMarkdown(filterAbout(aboutEntity(d, 'monka-care')!), {});
    expect(markdown).toContain('# Monka.care');
    expect(markdown).toContain('## Referenced by — meeting (1)');
    expect(markdown).toContain('## References — person (1)');
    expect(markdown).toContain('Kickoff');
    d.close();
  });

  it('renders one direction when asked for one', () => {
    const d = db();
    const entity = filterAbout(aboutEntity(d, 'monka-care')!);
    const incoming = renderAboutMarkdown(entity, { incoming: true });
    expect(incoming).toContain('## Referenced by');
    expect(incoming).not.toContain('## References');

    const outgoing = renderAboutMarkdown(entity, { outgoing: true });
    expect(outgoing).not.toContain('## Referenced by');
    expect(outgoing).toContain('## References');
    d.close();
  });

  it('says an entity is unreferenced only when it actually is', () => {
    const d = db();
    d.prepare('INSERT INTO notes VALUES (?,?,?,?,?)')
      .run('lonely-a', 'Lonely', 'note', 'active', 'Nothing points here.');
    const markdown = renderAboutMarkdown(filterAbout(aboutEntity(d, 'lonely-a')!), {});
    expect(markdown).toContain('Nothing links to this note');
    d.close();
  });

  it('distinguishes an empty filter from an unreferenced entity', () => {
    const d = db();
    const entity = filterAbout(aboutEntity(d, 'monka-care')!, ['source']);
    const markdown = renderAboutMarkdown(entity, {});
    expect(markdown).not.toContain('Nothing links to this note');
    expect(markdown).toContain('No source note references this one');
    expect(markdown).toContain('3 note(s) link here in total');
    d.close();
  });

  it('renders a pool with distance, sentences, and the judging boundary', () => {
    const d = db();
    const markdown = renderPoolMarkdown(entityPool(d, 'monka-care', { limit: 3 })!);
    expect(markdown).toContain('# Candidate pool around Monka.care');
    expect(markdown).toContain('## [1]');
    expect(markdown).toContain('Nothing is judged here');
    d.close();
  });

  it('renders an empty pool as a fact rather than as an empty list', () => {
    const d = db();
    d.prepare('INSERT INTO notes VALUES (?,?,?,?,?)')
      .run('lonely-a', 'Lonely', 'note', 'active', 'Nothing points here.');
    const markdown = renderPoolMarkdown(entityPool(d, 'lonely-a', {})!);
    expect(markdown).toContain('There is no candidate set to judge');
    d.close();
  });
});

describe('candidate sentence selection', () => {
  // These pin a defect that made every judge unable to answer from an imported note: the
  // six "sentences" were the first six lines that passed a length filter, which on real
  // source notes are File:/sourceNotionId:/sourceNotionUrl: and two lines of preamble. The
  // sentence carrying the figure sat 16th of 21 qualifying lines.

  it('drops metadata lines rather than spending the budget on them', () => {
    const body = [
      '- File: [discussion-package.md](assets/discussion-package.md)',
      'sourceNotionId: 357324e51ac2813cb372e77bad7dcb26',
      'sourceNotionUrl: https://www.notion.so/357324e51ac2813cb372e77bad7dcb26',
      'sourceDiscussionTitle: Migration Infrastructure et Conformité HDS Monka',
      'Meeting du 5 mai 2026 entre Stan Girard, Étienne Ruby et Stan Bernard.',
    ].join('\n');
    const out = candidateSentences(body, 6);
    expect(out.join(' ')).not.toContain('sourceNotionId');
    expect(out.join(' ')).not.toContain('sourceNotionUrl');
    expect(out.join(' ')).toContain('Meeting du 5 mai 2026');
  });

  it('reaches the end of a long body instead of returning its opening', () => {
    // The regression: a prefix of 6 could never contain the 16th qualifying sentence, and
    // a structured note puts its figures last.
    const filler = Array.from({ length: 14 }, (_, i) =>
      `Phrase de remplissage numéro ${i + 1} qui dépasse largement trente caractères.`);
    const body = [...filler, 'Proposition d’infogérance HDS : 1 975 € HT / mois, soit 71 100 € HT.'].join('\n');
    const out = candidateSentences(body, 6);
    expect(out.some(sentence => sentence.includes('1 975'))).toBe(true);
  });

  it('always includes the first and last candidate when sampling', () => {
    const body = Array.from({ length: 20 }, (_, i) =>
      `Phrase numéro ${i + 1} suffisamment longue pour être retenue comme candidate.`).join('\n');
    const out = candidateSentences(body, 4);
    expect(out[0]).toContain('numéro 1 ');
    expect(out[out.length - 1]).toContain('numéro 20');
    expect(out).toHaveLength(4);
  });

  it('returns everything in document order when the body is short', () => {
    const body = 'Première phrase assez longue pour compter dans le résultat.\nSeconde phrase assez longue pour compter aussi.';
    expect(candidateSentences(body, 10)).toHaveLength(2);
  });
});

describe('pool truncation reporting', () => {
  it('says how many notes each distance has, not just the total', () => {
    const d = db();
    // Three direct neighbours exist; ask for one and the pool must admit the other two.
    const pool = entityPool(d, 'monka-care', { limit: 1, sentences: 0 })!;
    const band = pool.by_distance.find(b => b.distance === 1)!;
    expect(band.shown).toBe(1);
    expect(band.reachable).toBeGreaterThan(1);
    expect(band.reachable - band.shown).toBeGreaterThan(0);
    d.close();
  });

  it('says so in the rendered text, so a reader cannot miss it', () => {
    const d = db();
    const markdown = renderPoolMarkdown(entityPool(d, 'monka-care', { limit: 1, sentences: 0 })!);
    expect(markdown).toContain('Reachable vs returned, per graph distance');
    expect(markdown).toMatch(/\d+ not returned/);
    expect(markdown).toContain('rather than concluding the vault does not have it');
    d.close();
  });

  it('does not claim truncation when nothing was dropped', () => {
    const d = db();
    const markdown = renderPoolMarkdown(entityPool(d, 'monka-care', { limit: 500, sentences: 0 })!);
    expect(markdown).not.toContain('not returned');
    d.close();
  });
});

describe('the default pool is bounded by what it costs, not by a round number', () => {
  // A large nearest band defaults to titles only. Measured on the real vault: 87 candidates
  // with sentences is ~18.5k tokens, the same 87 as titles is ~2.8k, and 30 with sentences is
  // ~6.3k but drops the note that answers. Returning the whole band cheaply, and saying so,
  // is the only option that keeps both recall and a bounded payload.
  const big = () => {
    const d = db();
    const note = d.prepare('INSERT INTO notes VALUES (?,?,?,?,?)');
    const link = d.prepare('INSERT INTO links VALUES (?,?,?,?)');
    for (let i = 0; i < 60; i++) {
      note.run(`n${i}`, `Note ${i}`, 'note', 'active',
        'This note has a sentence long enough to be selected as a candidate.');
      link.run(`n${i}`, 'monka-care', 'Monka.care', `ref [[Monka.care]] ${i}`);
    }
    return d;
  };

  it('defaults to a useful pool, not a fixed 30 that drops the answer', () => {
    // A fixed 30 dropped the note holding a client's price, which sat 54th of 87 direct
    // neighbours. The default is a floor of 60, so that note is inside it.
    const d = big();
    const pool = entityPool(d, 'monka-care', {})!;
    expect(pool.candidates.length).toBeGreaterThanOrEqual(60);
    const nearest = pool.by_distance.find(b => b.distance === 1)!;
    expect(nearest.shown).toBe(60);
    expect(nearest.reachable).toBe(63);
    d.close();
  });

  it('keeps a useful pool when the nearest band is degenerate', () => {
    // A leaf with one neighbour must not get a one-candidate pool while the notes that link
    // to that neighbour are reachable one hop further out. "The nearest band" as a default
    // failed exactly here: 34 anchors in the real vault have a single one-hop neighbour.
    const d = new Database(':memory:');
    d.exec(`
      CREATE TABLE notes (slug TEXT PRIMARY KEY, title TEXT, type TEXT, status TEXT, body TEXT);
      CREATE TABLE links (source_slug TEXT, target_slug TEXT, target_raw TEXT, context TEXT);
    `);
    const note = d.prepare('INSERT INTO notes VALUES (?,?,?,?,?)');
    const link = d.prepare('INSERT INTO links VALUES (?,?,?,?)');
    note.run('hub', 'Hub', 'organization', 'active', 'The only note that links to the leaf.');
    note.run('leaf-a', 'Leaf', 'note', 'active', 'A note with exactly one neighbour.');
    link.run('hub', 'leaf-a', 'leaf-a', 'x');
    for (let i = 0; i < 5; i++) {
      // These link the HUB, not the leaf, so the leaf's only neighbour stays the hub and
      // these sit at distance 2 from it.
      note.run(`far${i}`, `Far ${i}`, 'note', 'active', 'A note two hops from the leaf.');
      link.run(`far${i}`, 'hub', 'hub', 'x');
    }
    const pool = entityPool(d, 'leaf-a', {})!;
    const one = pool.by_distance.find(b => b.distance === 1)!;
    expect(one.reachable).toBe(1);
    // The default fills up from the next band instead of returning a single candidate.
    expect(pool.candidates.length).toBeGreaterThan(1);
    expect(pool.by_distance.find(b => b.distance === 2)!.shown).toBeGreaterThan(0);
    d.close();
  });

  it('caps an explicit limit rather than sending an unbounded request', () => {
    const d = big();
    const pool = entityPool(d, 'monka-care', { limit: 5000 })!;
    expect(pool.candidates.length).toBeLessThanOrEqual(255);
    d.close();
  });

  it('omits sentences for a large band and says so', () => {
    const d = big();
    const pool = entityPool(d, 'monka-care', {})!;
    expect(pool.sentences_omitted).toBe(true);
    expect(pool.candidates.every(c => c.sentences.length === 0)).toBe(true);
    expect(renderPoolMarkdown(pool)).toContain('Sentences were omitted');
    d.close();
  });

  it('still gives sentences for a small band', () => {
    const d = db();
    const pool = entityPool(d, 'monka-care', {})!;
    expect(pool.sentences_omitted).toBeFalsy();
    expect(pool.candidates.some(c => c.sentences.length > 0)).toBe(true);
    d.close();
  });

  it('honours an explicit sentences request even on a large band', () => {
    const d = big();
    const pool = entityPool(d, 'monka-care', { sentences: 6 })!;
    expect(pool.sentences_omitted).toBe(false);
    expect(pool.candidates.some(c => c.sentences.length > 0)).toBe(true);
    d.close();
  });

  it('honours an explicit small limit with sentences', () => {
    const d = big();
    const pool = entityPool(d, 'monka-care', { limit: 10 })!;
    expect(pool.candidates).toHaveLength(10);
    expect(pool.sentences_omitted).toBe(false);
    expect(pool.by_distance.find(b => b.distance === 1)!.shown).toBe(10);
    d.close();
  });
});

describe('sampling invariants', () => {
  const bodyOf = (n: number) => Array.from({ length: n }, (_, i) =>
    `Phrase numero ${String(i).padStart(2, '0')} suffisamment longue pour etre retenue.`).join('\n');
  const allOf = (n: number) => candidateSentences(bodyOf(n), n);

  it('never repeats a sentence to fill the budget', () => {
    // The stride clamp used to collapse onto one index: limit 7 over 8 returned [0,1,2,3,3,5,7],
    // wasting a slot and a judge option on the same sentence twice.
    for (const [n, limit] of [[8, 7], [12, 11], [9, 8], [8, 6], [21, 6]] as const) {
      const all = allOf(n);
      const picked = candidateSentences(bodyOf(n), limit);
      expect(new Set(picked).size, `n=${n} limit=${limit} repeated a sentence`).toBe(picked.length);
      expect(picked).toHaveLength(limit);
      // order is document order, so a caller can read it top to bottom
      const indices = picked.map(s => all.indexOf(s));
      expect([...indices].sort((a, b) => a - b)).toEqual(indices);
    }
  });

  it('never exceeds the requested count', () => {
    for (let n = 2; n <= 60; n++) {
      for (let limit = 1; limit <= Math.min(30, n); limit++) {
        const picked = candidateSentences(bodyOf(n), limit);
        expect(picked.length, `n=${n} limit=${limit}`).toBeLessThanOrEqual(limit);
      }
    }
  });

  it('keeps the opening of a long body, which a bare stride dropped', () => {
    // Round-1 finding: a pure stride returned [0,1,3,4,6,7] at n=8/limit=6 and lost indices
    // 2 and 5 that the old prefix kept.
    const all = allOf(8);
    const indices = candidateSentences(bodyOf(8), 6).map(s => all.indexOf(s));
    expect(indices).toContain(2);
    expect(indices).toContain(5);
  });
});

describe('the depth bound is reported too, not only the limit', () => {
  // The limit axis was protected and the depth axis was not: a pool capped by `depth` looked
  // exactly like a complete one, so an absence verdict said "the vault does not have it" when
  // the walk had simply stopped. That is the same false claim in the other direction.
  it('counts the notes one hop beyond the walked depth', () => {
    const d = db();
    // monka-care links to person-a; person-a links to nobody new, so a depth-1 walk from
    // monka-care has nothing beyond it except what it already saw.
    const shallow = entityPool(d, 'monka-care', { depth: 1, sentences: 0 })!;
    expect(shallow.beyond_depth).toBe(0);

    // Add a note only reachable through a depth-2 node, then walk at depth 1.
    d.prepare('INSERT INTO notes VALUES (?,?,?,?,?)')
      .run('far-a', 'Far', 'note', 'active', 'Two hops from the anchor.');
    d.prepare('INSERT INTO links VALUES (?,?,?,?)').run('person-a', 'far-a', 'far-a', 'x');
    const capped = entityPool(d, 'monka-care', { depth: 1, sentences: 0 })!;
    expect(capped.beyond_depth).toBeGreaterThan(0);
    d.close();
  });

  it('says so in the prose', () => {
    const d = db();
    d.prepare('INSERT INTO notes VALUES (?,?,?,?,?)')
      .run('far-a', 'Far', 'note', 'active', 'Two hops from the anchor.');
    d.prepare('INSERT INTO links VALUES (?,?,?,?)').run('person-a', 'far-a', 'far-a', 'x');
    const markdown = renderPoolMarkdown(entityPool(d, 'monka-care', { depth: 1, sentences: 0 })!);
    expect(markdown).toContain('Depth bound reached');
    d.close();
  });

  it('does not cry depth-bound when the walk covered everything', () => {
    const d = db();
    const markdown = renderPoolMarkdown(entityPool(d, 'monka-care', { depth: 2, sentences: 0 })!);
    expect(markdown).not.toContain('Depth bound reached');
    d.close();
  });

  it('counts only real notes, never dangling link targets', () => {
    // `reachable` was `distance.size`, which counted dangling targets while the per-hop rows
    // did not, so the rendered "judged X of Y" sentence could contradict the table under it.
    const d = db();
    d.prepare('INSERT INTO links VALUES (?,?,?,?)').run('monka-care', 'not-a-note', 'not-a-note', 'x');
    const pool = entityPool(d, 'monka-care', { sentences: 0 })!;
    const perHop = pool.by_distance.reduce((total, band) => total + band.reachable, 0);
    expect(pool.reachable).toBe(perHop);
    d.close();
  });
});
