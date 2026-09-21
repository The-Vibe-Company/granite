import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { aboutEntity } from '../../src/core/about.js';

/**
 * Minimal stand-in for the index: `aboutEntity` is a read of the graph, so the test
 * builds the two tables it touches rather than a whole vault.
 */
function db(): Database.Database {
  const d = new Database(':memory:');
  d.exec(`
    CREATE TABLE notes (slug TEXT PRIMARY KEY, title TEXT, type TEXT, status TEXT);
    CREATE TABLE links (source_slug TEXT, target_slug TEXT, target_raw TEXT, context TEXT);
  `);
  const note = d.prepare('INSERT INTO notes VALUES (?,?,?,?)');
  note.run('monka-care', 'Monka.care', 'organization', 'active');
  note.run('meeting-a', 'Kickoff with Monka', 'meeting', 'active');
  note.run('person-a', 'Étienne Rubi', 'person', 'active');
  note.run('synthesis-a', 'HDS synthesis', 'synthesis', 'active');
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
